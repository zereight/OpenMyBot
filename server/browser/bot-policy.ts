import {
  browserUrlRefusal,
  evaluateBrowserUrl,
  hasBrowserPolicy,
  type BrowserPolicy,
} from "../../shared/browser-policy.ts";
import type { BrowserStatus } from "./dispatch.ts";
import type { ToolCall } from "./tools.ts";

const URL_ARGS_TOOL_NAMES = new Set([
  "agent_browser_open",
  "agent_browser_navigate",
  "agent_browser_read",
  "agent_browser_tabs",
  "agent_browser_tab_new",
]);

const LEGACY_PAGE_URL_PATTERNS = [
  /^Opened\s+(\S+)/im,
  /^Navigated to\s+(\S+)/im,
  /^URL:\s*(\S+)/im,
  /^Page:\s*.*?\((https?:\/\/[^)\s]+)\)/im,
  /\bis (?:now|open) at\s+(\S+?)[.,;)\s]/i,
  /^https?:\/\/\S+$/i,
];

export function browserToolCallRefusal(policy: BrowserPolicy | undefined, params: unknown): string | null {
  if (!hasBrowserPolicy(policy) || !params || typeof params !== "object") return null;
  const call = params as { name?: unknown; arguments?: unknown };
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? (call.arguments as Record<string, unknown>)
    : null;
  if (!args || !Object.hasOwn(args, "url") || args.url === undefined) return null;
  if (typeof args.url !== "string") {
    return "Browser navigation is blocked by this bot's browser policy because the URL is invalid.";
  }
  const trimmed = args.url.trim();
  if (!trimmed) {
    if (call.name === "agent_browser_navigate") {
      return "Browser navigation is blocked by this bot's browser policy because the URL is empty.";
    }
    return null;
  }
  if (typeof call.name === "string" && !URL_ARGS_TOOL_NAMES.has(call.name) && call.name === "agent_browser_wait") {
    return null;
  }
  return browserUrlRefusal(policy, trimmed);
}

export function isTabEscapeAllowed(policy: BrowserPolicy | undefined, call: ToolCall): boolean {
  if (!hasBrowserPolicy(policy)) return true;
  switch (call.name) {
    case "restart_browser":
    case "agent_browser_close":
      return true;
    case "agent_browser_status":
      return call.as === undefined;
    case "agent_browser_tabs":
      if (call.input.action === "list" || call.input.action === "close") return true;
      if (call.input.action === "new") {
        const url = call.input.url?.trim();
        return !url || evaluateBrowserUrl(policy, url).allowed;
      }
      return false;
    case "agent_browser_open":
    case "agent_browser_navigate":
    case "agent_browser_read": {
      const url = call.input.url?.trim();
      return Boolean(url) && evaluateBrowserUrl(policy, url!).allowed;
    }
    default:
      return false;
  }
}

function blockedLabelFor(policy: BrowserPolicy, rawUrl: string): string | null {
  const decision = evaluateBrowserUrl(policy, rawUrl);
  if (decision.allowed) return null;
  return decision.host ? `blocked://${decision.host}` : "blocked://policy";
}

export function redactBrowserStatus(policy: BrowserPolicy | undefined, status: BrowserStatus): BrowserStatus {
  if (!hasBrowserPolicy(policy)) return status;
  const activeBlocked = status.url ? blockedLabelFor(policy, status.url) : null;
  return {
    ...status,
    url: activeBlocked ?? status.url,
    title: activeBlocked ? "[blocked by browser policy]" : status.title,
    dialog: activeBlocked ? null : status.dialog,
    fileChooser: activeBlocked ? null : status.fileChooser,
    signInPrompt: activeBlocked ? null : status.signInPrompt,
    tabs: status.tabs.map((listed) => {
      const blocked = listed.url ? blockedLabelFor(policy, listed.url) : null;
      if (!blocked) return listed;
      return { ...listed, url: blocked, title: "[blocked by browser policy]" };
    }),
    downloads: status.downloads.filter((download) => !download.url || evaluateBrowserUrl(policy, download.url).allowed),
  };
}

function extractLegacyCandidateUrls(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const urls: string[] = [];
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { url?: unknown; tabs?: unknown };
      if (typeof parsed.url === "string" && parsed.url.trim()) urls.push(parsed.url.trim());
    } catch {}
  }
  const head = trimmed.split("\n").slice(0, 6);
  for (const line of head) {
    const clean = line.trim();
    for (const pattern of LEGACY_PAGE_URL_PATTERNS) {
      const match = pattern.exec(clean);
      if (match) {
        const found = (match[1] ?? match[0]).replace(/[.,;)]+$/u, "");
        if (found) urls.push(found);
      }
    }
  }
  return urls;
}

export function refuseLegacyBrowserResult(policy: BrowserPolicy | undefined, result: unknown): unknown {
  if (!hasBrowserPolicy(policy) || !result || typeof result !== "object") return result;
  const shaped = result as { isError?: unknown; content?: unknown };
  if (shaped.isError === true || !Array.isArray(shaped.content)) return result;
  for (const part of shaped.content) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { type?: unknown; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") continue;
    for (const candidate of extractLegacyCandidateUrls(text)) {
      const refusal = browserUrlRefusal(policy, candidate);
      if (refusal) return { isError: true, content: [{ type: "text", text: refusal }] };
    }
  }
  return result;
}
