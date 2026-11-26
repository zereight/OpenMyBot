import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "omb-tool-guard.ts");

function run(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const call = (tool_name: string, tool_input: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });
const denial = (stdout: string) => JSON.parse(stdout).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };

describe("omb-tool-guard hook", () => {
  let scratch: string;
  let rules: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-tool-guard-"));
    rules = join(scratch, "policy.json");
    writeFileSync(rules, JSON.stringify({
      rules: [{ id: "delegate-pr", tools: ["native:shell", "native:web", "mcp:browser:*"], match: { patterns: ["bitbucket.org"] }, message: "Hand PR work to @PRCreator." }],
      protectedPaths: [join(scratch, "guardrails")],
    }));
  });

  afterEach(() => removeTempDir(scratch));

  it.each([
    ["a shell command (Claude and Codex both name it Bash)", call("Bash", { command: "curl https://bitbucket.org/acme/app/pull-requests/7" })],
    ["Claude's WebFetch", call("WebFetch", { url: "https://bitbucket.org/acme", prompt: "summarize" })],
    ["a browser MCP tool", call("mcp__browser__agent_browser_open", { url: "https://bitbucket.org/acme" })],
  ])("denies %s with the rule's message", async (_, stdin) => {
    const { code, stdout } = await run(["--rules", rules], stdin);
    expect(code).toBe(0);
    expect(denial(stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Blocked by bot guardrail (delegate-pr): Hand PR work to @PRCreator." });
  });

  it.each([
    ["a command the rule does not match", call("Bash", { command: "git status" })],
    ["a tool the rule does not select", call("Read", { file_path: "/tmp/bitbucket.org.txt" })],
    ["another event", JSON.stringify({ hook_event_name: "Stop", tool_name: "Bash", tool_input: { command: "curl bitbucket.org" } })],
  ])("prints nothing for %s", async (_, stdin) => {
    expect(await run(["--rules", rules], stdin)).toEqual({ code: 0, stdout: "" });
  });

  it("denies a shell or patch that writes into the policy folder, whatever the bot's own rules say", async () => {
    for (const stdin of [call("Bash", { command: `echo '[]' > ${join(scratch, "guardrails", "x.json")}` }),
      call("apply_patch", { command: `*** Begin Patch\n*** Add File: ${join(scratch, "guardrails", "x.json")}\n+[]\n*** End Patch` })]) {
      expect(denial((await run(["--rules", rules], stdin)).stdout).permissionDecisionReason).toMatch(/^Blocked by bot guardrail \(guardrail-self-protection\)/);
    }
  });

  it.each([
    ["no --rules", [], call("Bash", { command: "git status" })],
    ["a missing policy file", ["--rules", "missing.json"], call("Bash", { command: "git status" })],
    ["unparseable input", ["--rules", "RULES"], "{nope"],
    ["an oversized payload", ["--rules", "RULES"], call("Bash", { command: `git status #${"x".repeat(2 * 1024 * 1024)}` })],
  ])("denies every call on %s instead of letting it through", async (_, args, stdin) => {
    const { code, stdout } = await run(args.map((arg) => (arg === "RULES" ? rules : arg === "missing.json" ? join(scratch, arg) : arg)), stdin);
    expect(code).toBe(0);
    expect(denial(stdout).permissionDecision).toBe("deny");
  });
});
