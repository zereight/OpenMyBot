import { agentsCallIdentities } from "./agents-tool-names.ts";
import type { ToolIdentity } from "./tool-scope.ts";

export type ToolGuardrailMatchKind = "contains" | "regex";

export type ToolGuardrailMatch = {
  kind?: ToolGuardrailMatchKind;
  patterns?: string[];
  allPatterns?: string[];
  excludePatterns?: string[];
  fields?: string[];
};

export type ToolGuardrailRule = {
  id: string;
  enabled?: boolean;
  tools: string[];
  match?: ToolGuardrailMatch;
  message: string;
};

export type ParsedToolGuardrails =
  | { ok: true; rules: ToolGuardrailRule[] | undefined }
  | { ok: false; error: string };

export type ToolGuardrailVerdict =
  | { blocked: false }
  | { blocked: true; ruleId: string; message: string; reason: string };

export const NATIVE_GUARDRAILS_UNSUPPORTED = "this engine cannot check its own tools against the bot's guardrails. Limit the guardrails to mcp: selectors or choose Claude, Codex, Pi or an OpenAI-compatible engine.";

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const STRICT_CONTROL = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const MESSAGE_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

const MAX_RULES = 64;
const MAX_ID_LENGTH = 64;
const MAX_TOOLS_PER_RULE = 32;
const MAX_SELECTOR_LENGTH = 256;
const MAX_WILDCARDS = 4;
const MAX_PATTERNS_PER_LIST = 32;
const MAX_PATTERN_LENGTH = 256;
const MAX_FIELDS_PER_RULE = 32;
const MAX_MESSAGE_LENGTH = 500;
const MAX_WALK_DEPTH = 12;
const MAX_WALK_NODES = 512;

const NATIVE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  shell: [
    "bash", "powershell", "monitor", "exec_command", "shell", "shell_command",
    "local_shell", "run_command", "terminal", "write_stdin",
  ],
  edit: [
    "edit", "multiedit", "notebookedit", "apply_patch", "search_replace", "str_replace", "patch_file",
  ],
  write: [
    "write", "write_file", "create_file", "notebookedit", "apply_patch",
  ],
  read: [
    "read", "read_file", "view_image",
  ],
  web: [
    "webfetch", "websearch", "web_search", "fetch_url",
  ],
};

const SELF_PROTECTED_ALIASES = ["shell", "edit", "write"] as const;

const ALLOWED_RULE_KEYS = new Set<PropertyKey>(["id", "enabled", "tools", "match", "message"]);
const ALLOWED_MATCH_KEYS = new Set<PropertyKey>(["kind", "patterns", "allPatterns", "excludePatterns", "fields"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function countStars(value: string): number {
  let stars = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "*") stars++;
  }
  return stars;
}

function validPatternSegment(segment: string): boolean {
  return segment.trim().length > 0
    && segment.length <= MAX_SELECTOR_LENGTH
    && !STRICT_CONTROL.test(segment)
    && countStars(segment) <= MAX_WILDCARDS;
}

type ParsedSelector =
  | { kind: "any" }
  | { kind: "native"; pattern: string }
  | { kind: "mcp"; server: string; pattern: string };

function parseSelector(selector: string): ParsedSelector | undefined {
  if (typeof selector !== "string" || selector.length > MAX_SELECTOR_LENGTH || STRICT_CONTROL.test(selector)) {
    return undefined;
  }
  if (selector === "*") return { kind: "any" };
  if (selector.startsWith("native:")) {
    const pattern = selector.slice(7);
    if (validPatternSegment(pattern)) return { kind: "native", pattern };
    return undefined;
  }
  if (selector === "mcp:*") return { kind: "mcp", server: "*", pattern: "*" };
  if (selector.startsWith("mcp:")) {
    const separator = selector.indexOf(":", 4);
    if (separator < 0) return undefined;
    const server = selector.slice(4, separator);
    const pattern = selector.slice(separator + 1);
    if ((server === "*" || SERVER_NAME.test(server)) && validPatternSegment(pattern)) {
      return { kind: "mcp", server, pattern };
    }
  }
  return undefined;
}

function hasUnsafeRegexConstruct(pattern: string): boolean {
  if (/\\(?:[1-9]|k<)/.test(pattern)) return true;
  if (/\(\?<[=!]/.test(pattern)) return true;
  let inCharClass = false;
  let escaped = false;
  const groupHasQuantifier: boolean[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const ch = pattern[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (ch === "]") inCharClass = false;
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      continue;
    }
    if (ch === "(") {
      groupHasQuantifier.push(false);
      continue;
    }
    if (ch === ")") {
      const hadInner = groupHasQuantifier.pop() ?? false;
      const next = pattern[index + 1];
      const quantified = next === "+" || next === "*" || next === "{";
      if (hadInner && quantified) return true;
      if ((hadInner || quantified) && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if ((ch === "+" || ch === "*" || ch === "{") && groupHasQuantifier.length > 0) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }
  return false;
}

function compileRegex(pattern: string): RegExp | null {
  if (hasUnsafeRegexConstruct(pattern)) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function parsePatternList(value: unknown, kind: ToolGuardrailMatchKind, label: string): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERNS_PER_LIST) {
    return { ok: false, error: `Guardrail ${label} must be a non-empty list of up to ${MAX_PATTERNS_PER_LIST} patterns.` };
  }
  const items: string[] = [];
  for (const raw of Array.from(value)) {
    if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_PATTERN_LENGTH || STRICT_CONTROL.test(raw)) {
      return { ok: false, error: `Guardrail ${label} contains an invalid pattern.` };
    }
    if (kind === "regex" && compileRegex(raw) === null) {
      return { ok: false, error: `Guardrail ${label} contains an invalid or unsafe regex pattern.` };
    }
    items.push(raw);
  }
  return { ok: true, list: [...new Set(items)] };
}

function parseMatch(value: unknown): { ok: true; match: ToolGuardrailMatch } | { ok: false; error: string } {
  if (!isPlainRecord(value)) return { ok: false, error: "Guardrail match must be an object." };
  for (const key of Reflect.ownKeys(value)) {
    if (!ALLOWED_MATCH_KEYS.has(key)) return { ok: false, error: `Unknown guardrail match field: ${String(key)}.` };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return { ok: false, error: "Invalid guardrail match field." };
  }
  const kind = value.kind ?? "contains";
  if (kind !== "contains" && kind !== "regex") return { ok: false, error: 'Guardrail match.kind must be "contains" or "regex".' };
  const match: ToolGuardrailMatch = value.kind !== undefined ? { kind } : {};
  if (value.patterns !== undefined) {
    const parsed = parsePatternList(value.patterns, kind, "match.patterns");
    if (!parsed.ok) return parsed;
    match.patterns = parsed.list;
  }
  if (value.allPatterns !== undefined) {
    const parsed = parsePatternList(value.allPatterns, kind, "match.allPatterns");
    if (!parsed.ok) return parsed;
    match.allPatterns = parsed.list;
  }
  if (!match.patterns?.length && !match.allPatterns?.length) {
    return { ok: false, error: "Guardrail match requires patterns or allPatterns." };
  }
  if (value.excludePatterns !== undefined) {
    const parsed = parsePatternList(value.excludePatterns, kind, "match.excludePatterns");
    if (!parsed.ok) return parsed;
    match.excludePatterns = parsed.list;
  }
  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > MAX_FIELDS_PER_RULE) {
      return { ok: false, error: `Guardrail match.fields must list 1 to ${MAX_FIELDS_PER_RULE} field names.` };
    }
    const fields: string[] = [];
    for (const raw of Array.from(value.fields)) {
      if (typeof raw !== "string" || !FIELD_NAME.test(raw.trim())) {
        return { ok: false, error: "Guardrail match.fields contains an invalid field path." };
      }
      fields.push(raw.trim());
    }
    match.fields = [...new Set(fields)];
  }
  return { ok: true, match };
}

/** Validates and normalizes bot toolGuardrails. Undefined or an empty list means no rules; invalid input fails closed. */
export function parseToolGuardrails(value: unknown): ParsedToolGuardrails {
  if (value === undefined) return { ok: true, rules: undefined };
  if (!Array.isArray(value)) return { ok: false, error: "Tool guardrails must be a list of rules." };
  if (value.length === 0) return { ok: true, rules: undefined };
  if (value.length > MAX_RULES) return { ok: false, error: `At most ${MAX_RULES} tool guardrail rules are allowed.` };

  const seenIds = new Set<string>();
  const rules: ToolGuardrailRule[] = [];
  for (const entry of Array.from(value)) {
    if (!isPlainRecord(entry)) return { ok: false, error: "Each tool guardrail rule must be an object." };
    for (const key of Reflect.ownKeys(entry)) {
      if (!ALLOWED_RULE_KEYS.has(key)) return { ok: false, error: `Unknown tool guardrail field: ${String(key)}.` };
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !("value" in descriptor)) return { ok: false, error: "Invalid tool guardrail field." };
    }
    if (typeof entry.id !== "string") return { ok: false, error: "Each tool guardrail rule requires a string id." };
    const id = entry.id.trim();
    if (!id || id.length > MAX_ID_LENGTH || STRICT_CONTROL.test(id)) {
      return { ok: false, error: "Tool guardrail rule id must be 1 to 64 printable characters." };
    }
    if (seenIds.has(id)) return { ok: false, error: `Duplicate tool guardrail rule id: ${id}.` };
    seenIds.add(id);

    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      return { ok: false, error: `Guardrail "${id}" enabled must be a boolean.` };
    }

    if (!Array.isArray(entry.tools) || entry.tools.length === 0 || entry.tools.length > MAX_TOOLS_PER_RULE) {
      return { ok: false, error: `Guardrail "${id}" must specify 1 to ${MAX_TOOLS_PER_RULE} tool selectors.` };
    }
    const tools: string[] = [];
    for (const rawSelector of Array.from(entry.tools)) {
      if (typeof rawSelector !== "string" || !parseSelector(rawSelector.trim())) {
        return { ok: false, error: `Guardrail "${id}" has an invalid tool selector.` };
      }
      tools.push(rawSelector.trim());
    }

    let match: ToolGuardrailMatch | undefined;
    if (entry.match !== undefined) {
      const parsedMatch = parseMatch(entry.match);
      if (!parsedMatch.ok) return { ok: false, error: `Guardrail "${id}": ${parsedMatch.error}` };
      match = parsedMatch.match;
    }

    if (typeof entry.message !== "string") return { ok: false, error: `Guardrail "${id}" requires a message.` };
    const message = entry.message.trim();
    if (!message || message.length > MAX_MESSAGE_LENGTH || MESSAGE_CONTROL.test(message)) {
      return { ok: false, error: `Guardrail "${id}" message must be 1 to ${MAX_MESSAGE_LENGTH} characters.` };
    }

    rules.push({
      id,
      ...(entry.enabled === false ? { enabled: false } : {}),
      tools: [...new Set(tools)],
      ...(match ? { match } : {}),
      message,
    });
  }
  return { ok: true, rules };
}

export function activeToolGuardrails(rules: readonly ToolGuardrailRule[] | undefined): ToolGuardrailRule[] {
  return (rules ?? []).filter((rule) => rule.enabled !== false);
}

export function hasMcpToolGuardrails(rules: unknown): boolean {
  const parsed = parseToolGuardrails(rules);
  if (!parsed.ok) return true;
  return activeToolGuardrails(parsed.rules).some((rule) =>
    rule.tools.some((selector) => {
      const target = parseSelector(selector);
      return target?.kind === "any" || target?.kind === "mcp";
    }),
  );
}

export function hasNativeToolGuardrails(rules: unknown): boolean {
  const parsed = parseToolGuardrails(rules);
  if (!parsed.ok) return true;
  return activeToolGuardrails(parsed.rules).some((rule) =>
    rule.tools.some((selector) => {
      const target = parseSelector(selector);
      return target?.kind === "any" || target?.kind === "native";
    }),
  );
}

function canonicalRuleSignature(rule: ToolGuardrailRule): string {
  const match = rule.match
    ? {
      kind: rule.match.kind ?? "contains",
      patterns: [...(rule.match.patterns ?? [])].sort(),
      allPatterns: [...(rule.match.allPatterns ?? [])].sort(),
      excludePatterns: [...(rule.match.excludePatterns ?? [])].sort(),
      fields: [...(rule.match.fields ?? [])].sort(),
    }
    : null;
  return JSON.stringify({ tools: [...rule.tools].sort(), match });
}

/** Conservative widening check: any removal, disabling, or selector/match edit of a previously enabled rule counts as widening. */
export function toolGuardrailsWidens(previous: unknown, next: unknown): boolean {
  const before = parseToolGuardrails(previous);
  const after = parseToolGuardrails(next);
  if (!after.ok) return false;
  if (!before.ok) return true;
  const beforeActive = activeToolGuardrails(before.rules);
  if (beforeActive.length === 0) return false;
  const afterSignatures = new Set(activeToolGuardrails(after.rules).map(canonicalRuleSignature));
  return beforeActive.some((rule) => !afterSignatures.has(canonicalRuleSignature(rule)));
}

function matchesGlob(pattern: string, candidate: string): boolean {
  const lowerPattern = pattern.toLowerCase();
  const lowerValue = candidate.toLowerCase();
  if (lowerPattern === "*") return true;
  if (!lowerPattern.includes("*")) return lowerPattern === lowerValue;
  const parts = lowerPattern.split("*");
  let cursor = 0;
  if (parts[0] && !lowerValue.startsWith(parts[0])) return false;
  cursor = parts[0]!.length;
  for (let index = 1; index < parts.length - 1; index++) {
    const part = parts[index]!;
    if (!part) continue;
    const found = lowerValue.indexOf(part, cursor);
    if (found < 0) return false;
    cursor = found + part.length;
  }
  const tail = parts[parts.length - 1]!;
  if (tail) {
    return lowerValue.length >= cursor + tail.length && lowerValue.endsWith(tail);
  }
  return true;
}

function matchesNativePattern(pattern: string, toolName: string): boolean {
  if (matchesGlob(pattern, toolName)) return true;
  const aliasMembers = NATIVE_ALIASES[pattern.toLowerCase()];
  if (!aliasMembers) return false;
  const normalized = toolName.toLowerCase();
  return aliasMembers.includes(normalized);
}

function matchesToolSelector(selector: string, tool: ToolIdentity, args?: unknown): boolean {
  const parsed = parseSelector(selector);
  if (!parsed) return false;
  if (parsed.kind === "any") return true;
  if (parsed.kind === "native") {
    return tool.kind === "native" && matchesNativePattern(parsed.pattern, tool.name);
  }
  if (tool.kind !== "mcp") return false;
  if (parsed.server !== "*" && parsed.server !== tool.server) return false;
  const nameGroups = tool.server === "agents" ? agentsCallIdentities(tool.name, args) : [[tool.name]];
  return nameGroups.some((group) => group.some((candidate) => matchesGlob(parsed.pattern, candidate)));
}

/** Parses Claude/Codex/hook wire tool names (e.g. `mcp__browser__agent_browser_open` or `Bash`) into a ToolIdentity. */
export function parseRawToolIdentity(toolName: string): ToolIdentity {
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice(5);
    const separator = rest.indexOf("__");
    if (separator > 0) {
      const server = rest.slice(0, separator);
      const name = rest.slice(separator + 2);
      if (SERVER_NAME.test(server) && name) return { kind: "mcp", server, name };
    }
  }
  return { kind: "native", name: toolName };
}

function collectAllStrings(value: unknown, output: string[], state: { nodes: number }, depth: number): void {
  if (value === null || value === undefined || depth > MAX_WALK_DEPTH || state.nodes >= MAX_WALK_NODES) return;
  state.nodes++;
  if (typeof value === "string") {
    if (value) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAllStrings(item, output, state, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectAllStrings(nested, output, state, depth + 1);
    }
  }
}

function collectPrimitiveOrStrings(value: unknown, output: string[], state: { nodes: number }, depth: number): void {
  if (value === null || value === undefined || depth > MAX_WALK_DEPTH || state.nodes >= MAX_WALK_NODES) return;
  if (typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return;
  }
  collectAllStrings(value, output, state, depth);
}

function collectDotPath(value: unknown, segments: readonly string[], index: number, output: string[], state: { nodes: number }): void {
  if (value === null || value === undefined || state.nodes >= MAX_WALK_NODES) return;
  state.nodes++;
  if (index >= segments.length) {
    collectPrimitiveOrStrings(value, output, state, 0);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDotPath(item, segments, index, output, state);
    return;
  }
  if (typeof value === "object") {
    const target = segments[index]!.toLowerCase();
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === target) collectDotPath(nested, segments, index + 1, output, state);
    }
  }
}

function collectKeyRecursive(value: unknown, targetKey: string, output: string[], state: { nodes: number }, depth: number): void {
  if (value === null || value === undefined || depth > MAX_WALK_DEPTH || state.nodes >= MAX_WALK_NODES) return;
  state.nodes++;
  if (Array.isArray(value)) {
    for (const item of value) collectKeyRecursive(item, targetKey, output, state, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === targetKey) {
        collectPrimitiveOrStrings(nested, output, state, depth + 1);
      } else {
        collectKeyRecursive(nested, targetKey, output, state, depth + 1);
      }
    }
  }
}

function extractMatchText(input: unknown, fields?: readonly string[]): string {
  const texts: string[] = [];
  const state = { nodes: 0 };
  if (!fields || fields.length === 0) {
    collectAllStrings(input, texts, state, 0);
  } else {
    for (const field of fields) {
      if (field.includes(".")) {
        collectDotPath(input, field.split("."), 0, texts, state);
      } else {
        collectKeyRecursive(input, field.toLowerCase(), texts, state, 0);
      }
    }
  }
  return texts.join("\n");
}

function patternMatchesText(pattern: string, kind: ToolGuardrailMatchKind, text: string): boolean {
  if (kind === "regex") {
    const compiled = compileRegex(pattern);
    return compiled ? compiled.test(text) : false;
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function matchesRuleArguments(match: ToolGuardrailMatch | undefined, input: unknown): boolean {
  if (!match) return true;
  const text = extractMatchText(input, match.fields);
  if (!text) return false;
  const kind = match.kind ?? "contains";
  if (match.excludePatterns?.some((pattern) => patternMatchesText(pattern, kind, text))) return false;
  if (match.allPatterns?.length && !match.allPatterns.every((pattern) => patternMatchesText(pattern, kind, text))) return false;
  if (match.patterns?.length && !match.patterns.some((pattern) => patternMatchesText(pattern, kind, text))) return false;
  return true;
}

function matchesProtectedPath(tool: ToolIdentity, input: unknown, protectedPaths: readonly string[]): boolean {
  if (tool.kind !== "native" || protectedPaths.length === 0) return false;
  if (!SELF_PROTECTED_ALIASES.some((alias) => matchesNativePattern(alias, tool.name))) return false;
  const text = extractMatchText(input);
  if (!text) return false;
  const normalizedText = text.replace(/\\/g, "/").toLowerCase();
  return protectedPaths.some((protectedPath) => {
    const normalized = protectedPath.trim().replace(/\\/g, "/").toLowerCase();
    return normalized.length > 0 && normalizedText.includes(normalized);
  });
}

export function formatGuardrailBlock(ruleId: string, message: string): string {
  return `Blocked by bot guardrail (${ruleId}): ${message}`;
}

/** Evaluates active guardrails (plus immutable policy-file self-protection) against a tool call. */
export function evaluateToolGuardrails(
  rules: unknown,
  call: { tool: ToolIdentity; input?: unknown },
  options?: { protectedPaths?: readonly string[] },
): ToolGuardrailVerdict {
  const parsed = parseToolGuardrails(rules);
  if (!parsed.ok) {
    return {
      blocked: true,
      ruleId: "invalid-policy",
      message: parsed.error,
      reason: formatGuardrailBlock("invalid-policy", parsed.error),
    };
  }
  const active = activeToolGuardrails(parsed.rules);
  if (active.length === 0) return { blocked: false };

  if (options?.protectedPaths?.length && matchesProtectedPath(call.tool, call.input, options.protectedPaths)) {
    const message = "Modifying OpenMyBot guardrail policy files is not allowed.";
    return {
      blocked: true,
      ruleId: "guardrail-self-protection",
      message,
      reason: formatGuardrailBlock("guardrail-self-protection", message),
    };
  }

  for (const rule of active) {
    if (!rule.tools.some((selector) => matchesToolSelector(selector, call.tool, call.input))) continue;
    if (!matchesRuleArguments(rule.match, call.input)) continue;
    return {
      blocked: true,
      ruleId: rule.id,
      message: rule.message,
      reason: formatGuardrailBlock(rule.id, rule.message),
    };
  }
  return { blocked: false };
}
