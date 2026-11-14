import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EXTERNAL_BROWSER_DENIAL } from "./browser-launch-guard.ts";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "omb-browser-guard.ts");

function run(stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER], { env: { ...process.env, OMB_ALLOW_EXTERNAL_BROWSER: "", ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const call = (tool_name: string, tool_input: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });

describe("omb-browser-guard hook", () => {
  it("denies a shell command that opens a browser, with the reason Claude Code relays to the bot", async () => {
    const { code, stdout } = await run(call("Bash", { command: 'open -a "Google Chrome" https://example.com' }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: EXTERNAL_BROWSER_DENIAL },
    });
  });

  it.each([
    ["an ordinary command", call("Bash", { command: "git status" })],
    ["another tool", call("Read", { file_path: "/tmp/a" })],
    ["another event", JSON.stringify({ hook_event_name: "Stop", tool_name: "Bash", tool_input: { command: "open https://example.com" } })],
    ["unparseable input", "{nope"],
    ["an empty payload", ""],
    ["a JSON array", "[]"],
  ])("prints nothing and exits 0 for %s", async (_label, stdin) => {
    expect(await run(stdin)).toEqual({ code: 0, stdout: "" });
  });

  it("ignores OMB_ALLOW_EXTERNAL_BROWSER: a bot's project settings can set it in the hook's environment, so the server decides", async () => {
    const { code, stdout } = await run(call("Bash", { command: "open https://example.com" }), { OMB_ALLOW_EXTERNAL_BROWSER: "1" });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("lets an oversized payload through", async () => {
    const { code, stdout } = await run(call("Bash", { command: `open https://example.com #${"x".repeat(2 * 1024 * 1024)}` }));
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
