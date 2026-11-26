import { describe, expect, it } from "vitest";

import { evaluateToolGuardrails, parseToolGuardrails, toolGuardrailsWidens, type ToolGuardrailRule } from "./tool-guardrails.ts";
import type { ToolIdentity } from "./tool-scope.ts";

const rule = (patch: Partial<ToolGuardrailRule> = {}): ToolGuardrailRule => ({ id: "r", tools: ["*"], message: "No.", ...patch });
const blocks = (rules: unknown, tool: ToolIdentity, input: unknown = {}) => evaluateToolGuardrails(rules, { tool, input }).blocked;
const native = (name: string): ToolIdentity => ({ kind: "native", name });
const mcp = (server: string, name: string): ToolIdentity => ({ kind: "mcp", server, name });

describe("parseToolGuardrails", () => {
  it("treats no list and an empty list as no rules", () => {
    expect(parseToolGuardrails(undefined)).toEqual({ ok: true, rules: undefined });
    expect(parseToolGuardrails([])).toEqual({ ok: true, rules: undefined });
  });

  it.each<[string, unknown]>([
    ["a non-list", { id: "r" }],
    ["an unknown field", [{ ...rule(), when: "always" }]],
    ["a duplicate id", [rule(), rule()]],
    ["no tools", [rule({ tools: [] })]],
    ["a selector it cannot read", [rule({ tools: ["browser"] })]],
    ["a match without patterns", [rule({ match: { excludePatterns: ["x"] } })]],
    ["an unknown match kind", [rule({ match: { kind: "glob" as never, patterns: ["x"] } })]],
    ["a regex that can backtrack forever", [rule({ match: { kind: "regex", patterns: ["(a+)+$"] } })]],
    ["an empty message", [rule({ message: " " })]],
    ["65 rules", Array.from({ length: 65 }, (_, index) => rule({ id: `r${index}` }))],
  ])("refuses %s", (_, value) => {
    expect(parseToolGuardrails(value).ok).toBe(false);
  });

  it("blocks every call when the stored rules cannot be read", () => {
    expect(evaluateToolGuardrails([{ id: "r" }], { tool: native("Read") })).toMatchObject({ blocked: true, ruleId: "invalid-policy" });
  });
});

describe("evaluateToolGuardrails", () => {
  it.each<[string, string, ToolIdentity, boolean]>([
    ["the shell alias covers Claude's and Codex's shell tools", "native:shell", native("Bash"), true],
    ["the shell alias covers Codex's exec_command", "native:shell", native("exec_command"), true],
    ["the edit alias covers apply_patch", "native:edit", native("apply_patch"), true],
    ["the web alias covers WebFetch", "native:web", native("WebFetch"), true],
    ["an alias does not reach other tools", "native:shell", native("Read"), false],
    ["a native selector never matches an MCP tool", "native:*", mcp("browser", "agent_browser_open"), false],
    ["an MCP tool glob", "mcp:atlassian:*update*", mcp("atlassian", "confluence_update_page"), true],
    ["an MCP glob on another server", "mcp:atlassian:*update*", mcp("jira", "confluence_update_page"), false],
    ["every MCP server", "mcp:*", mcp("browser", "agent_browser_open"), true],
  ])("%s", (_, selector, tool, expected) => {
    expect(blocks([rule({ tools: [selector] })], tool)).toBe(expected);
  });

  it("matches patterns anywhere in the arguments, any of patterns, all of allPatterns, none of excludePatterns", () => {
    const git = [rule({ tools: ["native:shell"], match: { allPatterns: ["git"], patterns: ["push", "reset --hard"], excludePatterns: ["--dry-run"] } })];
    expect(blocks(git, native("Bash"), { command: "git push origin main" })).toBe(true);
    expect(blocks(git, native("Bash"), { command: "git reset --hard HEAD~1" })).toBe(true);
    expect(blocks(git, native("Bash"), { command: "git push --dry-run" })).toBe(false);
    expect(blocks(git, native("Bash"), { command: "git status" })).toBe(false);
    expect(blocks(git, native("Bash"), { command: "push" })).toBe(false);
  });

  it("looks only at the named fields, at any depth or by dot path", () => {
    const url = [rule({ tools: ["mcp:*"], match: { patterns: ["bitbucket.org"], fields: ["url"] } })];
    expect(blocks(url, mcp("web", "open"), { request: { url: "https://bitbucket.org/a" } })).toBe(true);
    expect(blocks(url, mcp("web", "open"), { note: "bitbucket.org" })).toBe(false);
    const dotted = [rule({ tools: ["mcp:*"], match: { patterns: ["main"], fields: ["ref.name"] } })];
    expect(blocks(dotted, mcp("git", "push"), { ref: { name: "main" }, name: "feature" })).toBe(true);
    expect(blocks(dotted, mcp("git", "push"), { ref: { name: "feature" }, name: "main" })).toBe(false);
  });

  it("skips a disabled rule and returns the first matching rule's message", () => {
    const rules = [rule({ id: "off", enabled: false }), rule({ id: "first", message: "Use @PRCreator." }), rule({ id: "second" })];
    expect(evaluateToolGuardrails(rules, { tool: native("Bash") })).toEqual({ blocked: true, ruleId: "first", message: "Use @PRCreator.",
      reason: "Blocked by bot guardrail (first): Use @PRCreator." });
  });

  it("protects the policy files from the bot's own shell and edits once any rule is active", () => {
    const protectedPaths = ["/data/runtime/guardrails", "~/.openmausbot/bots.json"];
    const narrow = [rule({ tools: ["mcp:jira:*"] })];
    const verdict = (tool: ToolIdentity, input: unknown, rules: unknown = narrow) => evaluateToolGuardrails(rules, { tool, input }, { protectedPaths });
    expect(verdict(native("Bash"), { command: "echo '[]' > /data/runtime/guardrails/a.json" })).toMatchObject({ ruleId: "guardrail-self-protection" });
    expect(verdict(native("Write"), { file_path: "~/.openmausbot/bots.json" })).toMatchObject({ ruleId: "guardrail-self-protection" });
    expect(verdict(native("Read"), { file_path: "/data/runtime/guardrails/a.json" })).toEqual({ blocked: false });
    expect(verdict(native("Bash"), { command: "echo '[]' > /data/runtime/guardrails/a.json" }, [])).toEqual({ blocked: false });
  });
});

describe("toolGuardrailsWidens", () => {
  const base = rule({ id: "pr", tools: ["native:shell"], match: { patterns: ["bitbucket.org"] } });
  it.each<[string, unknown, unknown, boolean]>([
    ["adding a rule", [base], [base, rule({ id: "more" })], false],
    ["changing only the message", [base], [{ ...base, message: "Ask @PRCreator." }], false],
    ["turning a rule on", [{ ...base, enabled: false }], [base], false],
    ["starting from invalid rules", [{ id: "r" }], [base], true],
    ["removing a rule", [base], [], true],
    ["turning a rule off", [base], [{ ...base, enabled: false }], true],
    ["narrowing its tools", [{ ...base, tools: ["native:shell", "native:web"] }], [base], true],
    ["changing its patterns", [base], [{ ...base, match: { patterns: ["github.com"] } }], true],
    ["clearing all rules", [base], undefined, true],
  ])("%s widens: %s", (_, before, after, expected) => {
    expect(toolGuardrailsWidens(before, after)).toBe(expected);
  });
});
