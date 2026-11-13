import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { attributionOf, attributionToCarry } from "./claude-attribution.ts";

const root = mkdtempSync(join(tmpdir(), "omb-attribution-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
function setup(user?: unknown, project?: unknown, local?: unknown) {
  const base = join(root, String(count++)), account = join(base, "account"), cwd = join(base, "cwd");
  mkdirSync(account, { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  if (user !== undefined) writeFileSync(join(account, "settings.json"), JSON.stringify(user));
  if (project !== undefined) writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(project));
  if (local !== undefined) writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify(local));
  return { account, cwd };
}

describe("attributionOf", () => {
  it("reads the object, false and the legacy flag, and drops wrong types", () => {
    expect(attributionOf({ attribution: { commit: "", pr: "x", sessionUrl: false } })).toEqual({ commit: "", pr: "x", sessionUrl: false });
    expect(attributionOf({ attribution: false })).toEqual({ commit: "", pr: "", sessionUrl: false });
    expect(attributionOf({ includeCoAuthoredBy: false })).toEqual({ commit: "", pr: "" });
    expect(attributionOf({ attribution: { commit: 1, pr: null, sessionUrl: "y" } })).toEqual({});
    expect(attributionOf({ attribution: true })).toEqual({});
  });
});

describe("attributionToCarry", () => {
  it("carries the person's opt-out into an isolated turn", () => {
    const { account, cwd } = setup({ attribution: { commit: "", pr: "" } });
    expect(attributionToCarry(account, cwd, undefined)).toEqual({ commit: "", pr: "" });
  });
  it("lets the bot beat the person, and leaves keys the project sets to Claude Code", () => {
    const { account, cwd } = setup({ attribution: { commit: "", pr: "" } }, { attribution: { pr: "repo" } });
    expect(attributionToCarry(account, cwd, { commit: "bot" })).toEqual({ commit: "bot" });
  });
  it("takes local settings, which Claude Code does not read here", () => {
    const { account, cwd } = setup({ attribution: { commit: "" } }, undefined, { attribution: { commit: "local" } });
    expect(attributionToCarry(account, cwd, undefined)).toEqual({ commit: "local" });
  });
  it("carries nothing when nothing is set or the file is missing", () => {
    expect(attributionToCarry(setup({}).account, setup({}).cwd, undefined)).toBeUndefined();
    expect(attributionToCarry(join(root, "none"), join(root, "none"), undefined)).toBeUndefined();
  });
});
