export interface BrowserHostRule {
  hosts: string[];
  reason?: string;
  delegateTo?: string;
}

export interface BrowserPolicy {
  rules?: BrowserHostRule[];
  allowHosts?: string[];
}

export type BrowserPolicyDecision =
  | { allowed: true; host?: string }
  | {
    allowed: false;
    kind: "rule" | "not-allowed" | "scheme" | "invalid-url";
    host?: string;
    matchedHost?: string;
    reason?: string;
    delegateTo?: string;
    message: string;
  };

export type ParsedBrowserPolicy =
  | { ok: true; policy: BrowserPolicy | undefined }
  | { ok: false; error: string };

const MAX_RULES = 64;
const MAX_HOSTS_PER_RULE = 64;
const MAX_ALLOW_HOSTS = 256;
const MAX_HOST_LENGTH = 253;
const MAX_REASON_LENGTH = 240;
const MAX_DELEGATE_LENGTH = 120;
const MAX_PROMPT_HOSTS = 12;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const STRIP_CONTROL = /[\x00-\x1f\x7f]+/g;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const SCHEME_PREFIX = /^([a-z][a-z\d+.-]*):/i;
const SCHEME_WITH_AUTHORITY = /^([a-z][a-z\d+.-]*):\/\//i;
const BARE_HOST_PORT = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]|[^\s/:?#]+):\d{1,5}(?:[/?#]|$)/i;
const WHITESPACE_OR_SLASH = /[\s/\\?#@^]/;

function sanitizeNote(value: string, maxLength: number): string {
  return value.replace(STRIP_CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function isIpLiteral(host: string): boolean {
  return host.includes(":") || IPV4_LITERAL.test(host);
}

export function normalizeBrowserHost(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HOST_LENGTH + 2) return null;
  if (CONTROL_CHAR.test(trimmed) || WHITESPACE_OR_SLASH.test(trimmed) || trimmed.includes("*")) return null;

  if (trimmed.includes(":")) {
    const bracketed = trimmed.startsWith("[") || trimmed.endsWith("]");
    if (bracketed && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return null;
    const inner = bracketed ? trimmed.slice(1, -1) : trimmed;
    if (!inner || inner.includes("[") || inner.includes("]")) return null;
    try {
      const parsed = new URL(`http://[${inner}]/`);
      if (!parsed.hostname.startsWith("[") || !parsed.hostname.endsWith("]")) return null;
      return parsed.hostname.slice(1, -1).toLowerCase();
    } catch {
      return null;
    }
  }

  const stripped = trimmed.replace(/\.+$/u, "");
  if (!stripped || stripped.startsWith(".") || stripped.includes("..") || stripped.includes("[") || stripped.includes("]")) return null;
  try {
    const parsed = new URL(`http://${stripped}/`);
    if (parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    const host = parsed.hostname.replace(/\.+$/u, "").toLowerCase();
    if (!host || host.length > MAX_HOST_LENGTH || host.startsWith(".") || host.includes("..")) return null;
    return host;
  } catch {
    return null;
  }
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  if (isIpLiteral(pattern)) return host === pattern;
  return host === pattern || host.endsWith(`.${pattern}`);
}

function validateHostEntry(raw: unknown, fieldPath: string): { ok: true; host: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: `${fieldPath} must be a hostname string` };
  const trimmed = raw.trim();
  if (trimmed.includes("*")) {
    return { ok: false, error: `${fieldPath}: omit wildcards such as '*.'; domain entries already match subdomains` };
  }
  const normalized = normalizeBrowserHost(trimmed);
  if (!normalized) return { ok: false, error: `${fieldPath}: invalid hostname ${JSON.stringify(trimmed.slice(0, 80))}` };
  return { ok: true, host: normalized };
}

function parseOptionalNote(raw: unknown, fieldPath: string, maxLength: number): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: `${fieldPath} must be a string` };
  if (CONTROL_CHAR.test(raw)) return { ok: false, error: `${fieldPath} must not contain control characters` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (trimmed.length > maxLength) return { ok: false, error: `${fieldPath} must be at most ${maxLength} characters` };
  return { ok: true, value: trimmed };
}

export function parseBrowserPolicy(value: unknown): ParsedBrowserPolicy {
  if (value === undefined) return { ok: true, policy: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "browserPolicy must be an object or null" };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "rules" && key !== "allowHosts") {
      return { ok: false, error: `browserPolicy has unsupported field ${JSON.stringify(key)}` };
    }
  }

  let rules: BrowserHostRule[] | undefined;
  if (record.rules !== undefined) {
    if (!Array.isArray(record.rules)) return { ok: false, error: "browserPolicy.rules must be an array" };
    if (record.rules.length > MAX_RULES) return { ok: false, error: `browserPolicy.rules allows at most ${MAX_RULES} rules` };
    const parsedRules: BrowserHostRule[] = [];
    for (let i = 0; i < record.rules.length; i++) {
      const rawRule = record.rules[i];
      if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
        return { ok: false, error: `browserPolicy.rules[${i}] must be an object` };
      }
      const ruleObj = rawRule as Record<string, unknown>;
      for (const key of Object.keys(ruleObj)) {
        if (key !== "hosts" && key !== "reason" && key !== "delegateTo") {
          return { ok: false, error: `browserPolicy.rules[${i}] has unsupported field ${JSON.stringify(key)}` };
        }
      }
      if (!Array.isArray(ruleObj.hosts) || ruleObj.hosts.length === 0) {
        return { ok: false, error: `browserPolicy.rules[${i}].hosts must be a non-empty array` };
      }
      if (ruleObj.hosts.length > MAX_HOSTS_PER_RULE) {
        return { ok: false, error: `browserPolicy.rules[${i}].hosts allows at most ${MAX_HOSTS_PER_RULE} hosts` };
      }
      const seen = new Set<string>();
      const hosts: string[] = [];
      for (let j = 0; j < ruleObj.hosts.length; j++) {
        const checked = validateHostEntry(ruleObj.hosts[j], `browserPolicy.rules[${i}].hosts[${j}]`);
        if (!checked.ok) return checked;
        if (!seen.has(checked.host)) {
          seen.add(checked.host);
          hosts.push(checked.host);
        }
      }
      const reason = parseOptionalNote(ruleObj.reason, `browserPolicy.rules[${i}].reason`, MAX_REASON_LENGTH);
      if (!reason.ok) return reason;
      const delegateTo = parseOptionalNote(ruleObj.delegateTo, `browserPolicy.rules[${i}].delegateTo`, MAX_DELEGATE_LENGTH);
      if (!delegateTo.ok) return delegateTo;
      parsedRules.push({
        hosts,
        ...(reason.value !== undefined ? { reason: reason.value } : {}),
        ...(delegateTo.value !== undefined ? { delegateTo: delegateTo.value } : {}),
      });
    }
    if (parsedRules.length > 0) rules = parsedRules;
  }

  let allowHosts: string[] | undefined;
  if (record.allowHosts !== undefined) {
    if (!Array.isArray(record.allowHosts)) return { ok: false, error: "browserPolicy.allowHosts must be an array" };
    if (record.allowHosts.length > MAX_ALLOW_HOSTS) {
      return { ok: false, error: `browserPolicy.allowHosts allows at most ${MAX_ALLOW_HOSTS} hosts` };
    }
    const seen = new Set<string>();
    const hosts: string[] = [];
    for (let i = 0; i < record.allowHosts.length; i++) {
      const checked = validateHostEntry(record.allowHosts[i], `browserPolicy.allowHosts[${i}]`);
      if (!checked.ok) return checked;
      if (!seen.has(checked.host)) {
        seen.add(checked.host);
        hosts.push(checked.host);
      }
    }
    allowHosts = hosts;
  }

  if (rules === undefined && allowHosts === undefined) return { ok: true, policy: undefined };
  return {
    ok: true,
    policy: {
      ...(rules !== undefined ? { rules } : {}),
      ...(allowHosts !== undefined ? { allowHosts } : {}),
    },
  };
}

export function hasBrowserPolicy(policy: BrowserPolicy | undefined): policy is BrowserPolicy {
  return Boolean(policy && ((policy.rules && policy.rules.length > 0) || policy.allowHosts !== undefined));
}

function formatRuleRefusal(host: string, rule: BrowserHostRule): string {
  const parts = [`Browser access to ${host} is blocked by this bot's browser policy.`];
  if (rule.reason) parts.push(`Reason: ${sanitizeNote(rule.reason, MAX_REASON_LENGTH)}.`);
  if (rule.delegateTo) parts.push(`Delegate this task to ${sanitizeNote(rule.delegateTo, MAX_DELEGATE_LENGTH)} instead.`);
  return parts.join(" ");
}

function formatNotAllowedRefusal(host: string, allowHosts: readonly string[]): string {
  if (allowHosts.length === 0) {
    return `Browser access to ${host} is blocked by this bot's browser policy (no hosts are allowed).`;
  }
  const shown = allowHosts.slice(0, 8).join(", ");
  const more = allowHosts.length > 8 ? ` (+${allowHosts.length - 8} more)` : "";
  return `Browser access to ${host} is not allowed by this bot's browser policy. Allowed hosts: ${shown}${more}.`;
}

export function evaluateBrowserHost(policy: BrowserPolicy | undefined, rawHost: string): BrowserPolicyDecision {
  if (!hasBrowserPolicy(policy)) return { allowed: true };
  const host = normalizeBrowserHost(rawHost);
  if (!host) {
    return {
      allowed: false,
      kind: "invalid-url",
      message: "Browser access is blocked by this bot's browser policy because the target host could not be verified.",
    };
  }

  let matched: { rule: BrowserHostRule; pattern: string } | null = null;
  for (const rule of policy.rules ?? []) {
    for (const pattern of rule.hosts) {
      if (!hostMatchesPattern(host, pattern)) continue;
      if (!matched || pattern.length > matched.pattern.length) {
        matched = { rule, pattern };
      }
    }
  }
  if (matched) {
    return {
      allowed: false,
      kind: "rule",
      host,
      matchedHost: matched.pattern,
      ...(matched.rule.reason ? { reason: matched.rule.reason } : {}),
      ...(matched.rule.delegateTo ? { delegateTo: matched.rule.delegateTo } : {}),
      message: formatRuleRefusal(host, matched.rule),
    };
  }

  if (policy.allowHosts !== undefined) {
    if (policy.allowHosts.some((pattern) => hostMatchesPattern(host, pattern))) {
      return { allowed: true, host };
    }
    return {
      allowed: false,
      kind: "not-allowed",
      host,
      message: formatNotAllowedRefusal(host, policy.allowHosts),
    };
  }

  return { allowed: true, host };
}

export function evaluateBrowserUrl(policy: BrowserPolicy | undefined, rawUrl: string): BrowserPolicyDecision {
  if (!hasBrowserPolicy(policy)) return { allowed: true };
  if (typeof rawUrl !== "string") {
    return {
      allowed: false,
      kind: "invalid-url",
      message: "Browser navigation is blocked by this bot's browser policy because the URL is invalid.",
    };
  }
  const text = rawUrl.trim();
  if (!text || CONTROL_CHAR.test(text)) {
    return {
      allowed: false,
      kind: "invalid-url",
      message: "Browser navigation is blocked by this bot's browser policy because the URL is invalid.",
    };
  }
  if (text.toLowerCase() === "about:blank") return { allowed: true };

  let candidate: string;
  const authorityScheme = SCHEME_WITH_AUTHORITY.exec(text);
  if (authorityScheme) {
    const scheme = authorityScheme[1]!.toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return {
        allowed: false,
        kind: "scheme",
        message: `Browser navigation to ${scheme}: URLs is blocked while this bot's browser policy is active. Only http(s) and about:blank URLs are allowed.`,
      };
    }
    candidate = text;
  } else if (BARE_HOST_PORT.test(text)) {
    candidate = `https://${text}`;
  } else if (SCHEME_PREFIX.test(text)) {
    const scheme = SCHEME_PREFIX.exec(text)![1]!.toLowerCase();
    return {
      allowed: false,
      kind: "scheme",
      message: `Browser navigation to ${scheme}: URLs is blocked while this bot's browser policy is active. Only http(s) and about:blank URLs are allowed.`,
    };
  } else if (text.startsWith("//")) {
    candidate = `https:${text}`;
  } else {
    candidate = `https://${text}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      allowed: false,
      kind: "invalid-url",
      message: "Browser navigation is blocked by this bot's browser policy because the URL could not be parsed.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      allowed: false,
      kind: "scheme",
      message: `Browser navigation to ${parsed.protocol} URLs is blocked while this bot's browser policy is active. Only http(s) and about:blank URLs are allowed.`,
    };
  }
  return evaluateBrowserHost(policy, parsed.hostname);
}

export function browserHostAllowed(policy: BrowserPolicy | undefined, rawHost: string): boolean {
  return evaluateBrowserHost(policy, rawHost).allowed;
}

export function browserHostRefusal(policy: BrowserPolicy | undefined, rawHost: string): string | null {
  const decision = evaluateBrowserHost(policy, rawHost);
  return decision.allowed ? null : decision.message;
}

export function browserUrlRefusal(policy: BrowserPolicy | undefined, rawUrl: string): string | null {
  const decision = evaluateBrowserUrl(policy, rawUrl);
  return decision.allowed ? null : decision.message;
}

function deniedPatterns(policy: BrowserPolicy | undefined): string[] {
  return (policy?.rules ?? []).flatMap((rule) => rule.hosts);
}

function patternOverlap(first: string, second: string): string | null {
  if (hostMatchesPattern(first, second)) return first;
  if (hostMatchesPattern(second, first)) return second;
  return null;
}

function coveredByAny(pattern: string, patterns: readonly string[]): boolean {
  return patterns.some((candidate) => hostMatchesPattern(pattern, candidate));
}

export function browserPolicyWidens(before: BrowserPolicy | undefined, after: BrowserPolicy | undefined): boolean {
  if (!hasBrowserPolicy(before)) return false;
  if (!hasBrowserPolicy(after)) return true;

  const beforeDeny = deniedPatterns(before);
  const afterDeny = deniedPatterns(after);

  if (before.allowHosts !== undefined) {
    if (after.allowHosts === undefined) return true;
    for (const afterAllow of after.allowHosts) {
      if (coveredByAny(afterAllow, afterDeny)) continue;
      if (!coveredByAny(afterAllow, before.allowHosts)) return true;
    }
  }

  for (const prevDenied of beforeDeny) {
    if (coveredByAny(prevDenied, afterDeny)) continue;
    if (after.allowHosts === undefined) return true;
    for (const afterAllow of after.allowHosts) {
      const overlap = patternOverlap(prevDenied, afterAllow);
      if (overlap !== null && !coveredByAny(overlap, afterDeny)) return true;
    }
  }

  return false;
}

export function browserPolicyPrompt(policy: BrowserPolicy | undefined): string {
  if (!hasBrowserPolicy(policy)) return "";
  const sentences: string[] = [];
  if (policy.rules?.length) {
    const ruleNotes = policy.rules.slice(0, 8).map((rule) => {
      const hosts = rule.hosts.slice(0, MAX_PROMPT_HOSTS).join(", ");
      const more = rule.hosts.length > MAX_PROMPT_HOSTS ? ` (+${rule.hosts.length - MAX_PROMPT_HOSTS} more)` : "";
      const extras: string[] = [];
      if (rule.delegateTo) extras.push(`delegate to ${sanitizeNote(rule.delegateTo, MAX_DELEGATE_LENGTH)}`);
      if (rule.reason) extras.push(sanitizeNote(rule.reason, MAX_REASON_LENGTH));
      return extras.length ? `${hosts}${more} (${extras.join("; ")})` : `${hosts}${more}`;
    });
    const moreRules = policy.rules.length > 8 ? ` and ${policy.rules.length - 8} more rule(s)` : "";
    sentences.push(`Blocked browser hosts for this bot: ${ruleNotes.join("; ")}${moreRules}.`);
  }
  if (policy.allowHosts !== undefined) {
    if (policy.allowHosts.length === 0) {
      sentences.push("No external hosts are allowed in the built-in browser for this bot.");
    } else {
      const shown = policy.allowHosts.slice(0, MAX_PROMPT_HOSTS).join(", ");
      const more = policy.allowHosts.length > MAX_PROMPT_HOSTS ? ` (+${policy.allowHosts.length - MAX_PROMPT_HOSTS} more)` : "";
      sentences.push(`Only these hosts are allowed in the built-in browser for this bot: ${shown}${more}.`);
    }
  }
  return sentences.length ? ` ${sentences.join(" ")}` : "";
}
