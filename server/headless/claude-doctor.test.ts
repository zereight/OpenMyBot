import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClaude, claudeReport } from "./claude-doctor.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

let root: string;
let dataDir: string;
let home: string;
const registered: Array<{ id: string; name: string; cwd?: string }> = [];

beforeEach(() => {
  registered.length = 0;
  root = mkdtempSync(join(tmpdir(), "omb-claude-doctor-"));
  dataDir = join(root, "data");
  home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function bot(id: string, name: string, settings: unknown, cwd?: string): string {
  const folder = cwd ?? join(dataDir, "workspaces", id);
  mkdirSync(join(folder, ".claude"), { recursive: true });
  const file = join(folder, ".claude", "settings.json");
  writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
  registered.push({ id, name, ...(cwd ? { cwd } : {}) });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(registered));
  return file;
}

const check = (id: string) => checkClaude({ dataDir, home }).find((entry) => entry.id === id);

describe("doctor --claude", () => {
  it("says what a bot's settings carry into turns, by event, count and name", () => {
    bot("b1", "Reviewer", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
      permissions: { allow: ["Read", "Bash(git status)"], deny: ["Bash(rm:*)"] },
      env: { REGION: "eu" },
    });
    expect(check("claude-bot-b1")).toEqual({
      id: "claude-bot-b1", status: "ok",
      message: `Bot "Reviewer": ${join(dataDir, "workspaces", "b1", ".claude", "settings.json")} carries hooks for Stop, 3 permission rules, 1 env variable into turns`,
    });
  });

  it("warns when a field has the wrong shape and a turn would drop it", () => {
    bot("b1", "Deploy", { hooks: { Stop: "node check.js" }, permissions: { allow: ["Read", 7, { rule: "Bash" }] } });
    const entry = check("claude-bot-b1")!;
    expect(entry.status).toBe("warn");
    expect(entry.message).toContain("`hooks` has the wrong shape, so turns in another folder carry none of it");
    expect(entry.message).toContain("`permissions`: 2 of 3 entries left out for the wrong shape");
  });

  it("warns about a rule that lets every shell command run", () => {
    for (const [index, rule] of ["Bash", "Bash(*)", "Bash(:*)", "*"].entries()) {
      bot(`b${index}`, `Bot${index}`, { permissions: { allow: [rule] } });
      expect(check(`claude-bot-b${index}`)!.message, rule).toContain("lets every shell command run without asking");
    }
    bot("scoped", "Scoped", { permissions: { allow: ["Bash(git status)", "Bash(npm run test:*)"] } });
    expect(check("claude-bot-scoped")!.status).toBe("ok");
  });

  it("warns about a link, a file that is not JSON, and one that is not an object", () => {
    const real = join(root, "elsewhere.json");
    writeFileSync(real, "{}");
    const file = bot("b1", "Linked", {});
    rmSync(file);
    symlinkSync(real, file);
    expect(check("claude-bot-b1")!.message).toContain("is a link, and turns never read through one");
    bot("b2", "Broken", "{ not json");
    expect(check("claude-bot-b2")!.message).toContain("is not a JSON object: Claude Code ignores it");
    bot("b3", "List", "[1]");
    expect(check("claude-bot-b3")!.message).toContain("is not a JSON object");
  });

  it("reads a bot's own working folder when it has one, and skips a bot without a settings file", () => {
    const folder = join(root, "project");
    bot("b1", "Project", { permissions: { allow: ["Read"] } }, folder);
    registered.push({ id: "b2", name: "Plain" });
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(registered));
    const checks = checkClaude({ dataDir, home });
    expect(checks.map((entry) => entry.id)).toEqual(["claude-skills", "claude-bot-b1"]);
    expect(checks[1]!.message).toContain(join(folder, ".claude", "settings.json"));
  });

  it("never prints a hook command, an env value or a rule's text", () => {
    bot("b1", "Secret", {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "curl -H 'Authorization: s3cret-token' https://x" }] }] },
      permissions: { allow: ["Bash(curl s3cret-token:*)"] },
      env: { API_KEY: "s3cret-token" },
    });
    const report = claudeReport(checkClaude({ dataDir, home }));
    expect(JSON.stringify(report)).not.toContain("s3cret-token");
    expect(report.human.join("\n")).toContain("hooks for PreToolUse, 1 permission rule, 1 env variable");
  });

  describe("shared skills", () => {
    const share = () => writeFileSync(join(dataDir, "config.json"), JSON.stringify({ features: { claudeUserSkills: true } }));

    it("is not a finding while sharing is off", () => {
      expect(check("claude-skills")).toMatchObject({ status: "ok", message: expect.stringContaining("are not shared with bots") });
    });

    it("warns when sharing is on and the folder is not there", () => {
      share();
      expect(check("claude-skills")).toMatchObject({ status: "warn", message: expect.stringContaining("is not a folder, so they get none") });
    });

    it("counts the skills, and names a folder that has no SKILL.md", () => {
      share();
      const skills = join(home, ".claude", "skills");
      mkdirSync(join(skills, "ship"), { recursive: true });
      writeFileSync(join(skills, "ship", "SKILL.md"), "---\nname: ship\n---\n");
      expect(check("claude-skills")).toMatchObject({ status: "ok", message: expect.stringContaining("the 1 skill in") });
      mkdirSync(join(skills, "draft"));
      expect(check("claude-skills")).toMatchObject({ status: "warn", message: expect.stringContaining("1 of 2 have no SKILL.md: draft") });
    });
  });

  it("is doctor --claude on the command line, takes --data-dir, and refuses flags of the others", async () => {
    bot("b1", "Deploy", { hooks: [] });
    const out: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: () => undefined, readStdin: async () => "" };
    expect(await runHeadless(["doctor", "--claude", "--json", "--data-dir", dataDir], { io, env: {} })).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, warnings: 1, checks: [{ id: "claude-skills", status: "ok" }, { id: "claude-bot-b1", status: "warn" }] });
    expect(await runHeadless(["doctor", "--claude", "--host"], { io, env: {} })).toBe(2);
    expect(await runHeadless(["doctor", "--claude", "--wait", "1m"], { io, env: {} })).toBe(2);
    expect(await runHeadless(["doctor", "--claude", "--domain", "maus.example.com"], { io, env: {} })).toBe(2);
  });
});
