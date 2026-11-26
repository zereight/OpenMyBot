import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { activeToolGuardrails, hasMcpToolGuardrails, hasNativeToolGuardrails, parseToolGuardrails } from "../../shared/tool-guardrails.ts";
import { writeFileAtomicIfChanged } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import type { GuardrailPolicy } from "../tool-guardrail-policy-file.ts";

const TOOL_GUARD_TIMEOUT_SECONDS = 5;
const POLICY_DIR = join(DATA_DIR, "runtime", "guardrails");

export function guardrailProtectedPaths(): string[] {
  const absolute = [resolve(POLICY_DIR), resolve(DATA_DIR, "bots.json")];
  const underHome = absolute.flatMap((path) => {
    const rest = relative(resolve(homedir()), path);
    return rest && !rest.startsWith("..") && !isAbsolute(rest) ? [`~/${rest}`] : [];
  });
  return [...absolute, ...underHome];
}

export function turnGuardrailFiles(turn: { threadId: string; botId?: string; toolGuardrails?: unknown }): { rulesPath?: string; mcpRulesPath?: string; nativeRulesPath?: string } {
  const parsed = parseToolGuardrails(turn.toolGuardrails);
  if (!parsed.ok) throw new Error(parsed.error);
  if (!parsed.rules || activeToolGuardrails(parsed.rules).length === 0) return {};
  mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
  const rulesPath = join(POLICY_DIR, `${createHash("sha256").update(`${turn.botId ?? ""}\0${turn.threadId}`).digest("hex").slice(0, 32)}.json`);
  const policy: GuardrailPolicy = { rules: parsed.rules, protectedPaths: guardrailProtectedPaths() };
  writeFileAtomicIfChanged(rulesPath, JSON.stringify(policy), { mode: 0o600, durable: false });
  return {
    rulesPath,
    ...(hasMcpToolGuardrails(parsed.rules) ? { mcpRulesPath: rulesPath } : {}),
    ...(hasNativeToolGuardrails(parsed.rules) ? { nativeRulesPath: rulesPath } : {}),
  };
}

function toolGuardShellCommand(helperPath: string, rulesPath: string, platform: NodeJS.Platform, execPath: string): string {
  const argv = [execPath, helperPath, "--rules", rulesPath];
  return platform === "win32"
    ? argv.map((part) => `"${part.replace(/"/g, '\\"')}"`).join(" ")
    : argv.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
}

interface CodexToolGuard {
  args: string[];
  command: string;
}

export function codexToolGuard(helperPath: string, rulesPath: string, platform: NodeJS.Platform = process.platform, execPath = process.execPath): CodexToolGuard {
  const command = toolGuardShellCommand(helperPath, rulesPath, platform, execPath);
  // Codex runs a session-flag hook only when hooks.state holds its trust hash: sha256 of the sorted-key JSON of the
  // hook's normalized identity (codex-rs hooks/src/engine/discovery.rs `hook_hash`, checked against Codex CLI 0.172.0).
  const identity = { event_name: "pre_tool_use", hooks: [{ async: false, command, timeout: TOOL_GUARD_TIMEOUT_SECONDS, type: "command" }], matcher: ".*" };
  const trustedHash = `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  const sessionFlags = platform === "win32" ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";
  return {
    command,
    args: [
      "-c", "features.hooks=true",
      "-c", `hooks.PreToolUse=[{ matcher = ".*", hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = ${TOOL_GUARD_TIMEOUT_SECONDS} }] }]`,
      "-c", `hooks.state={ ${JSON.stringify(`${sessionFlags}:pre_tool_use:0:0`)} = { trusted_hash = ${JSON.stringify(trustedHash)} } }`,
    ],
  };
}

interface CodexListedHook {
  source?: unknown;
  eventName?: unknown;
  command?: unknown;
  enabled?: unknown;
  trustStatus?: unknown;
}

export function codexToolGuardLoaded(listed: unknown, guard: CodexToolGuard): boolean {
  const entries = (listed as { data?: unknown } | null)?.data;
  return Array.isArray(entries) && entries.some((entry: { hooks?: unknown }) => Array.isArray(entry?.hooks)
    && entry.hooks.some((hook: CodexListedHook) => hook?.source === "sessionFlags" && hook.eventName === "preToolUse"
      && hook.command === guard.command && hook.enabled === true && hook.trustStatus === "trusted"));
}
