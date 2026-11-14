import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendRunRecord, compareRuns, hashOf, readLastRun, type RecordedItem, type RunRecord } from "./eval-record.ts";

const item = (id: string, outcome: string, itemHash = "h"): RecordedItem => ({ id, set: "s", itemHash, outcome });
const run = (items: RecordedItem[], over: Partial<RunRecord> = {}): RunRecord => ({ suite: "browser-clicks", ts: "t", provider: "jev", items, ...over });
const right = (outcome: string) => outcome === "right";

describe("compareRuns", () => {
  it("reports an item that was right and no longer is", () => {
    const out = compareRuns(run([item("a", "right"), item("b", "right")]), run([item("a", "wrong_pick"), item("b", "right")]), right);
    expect(out).toMatchObject({ comparable: true, regressed: ["a"], recovered: [], failed: [] });
  });

  it("reports a recovered item and ignores one that was wrong both times", () => {
    const out = compareRuns(run([item("a", "wrong_pick"), item("b", "missed")]), run([item("a", "right"), item("b", "missed")]), right);
    expect(out.recovered).toEqual(["a"]);
    expect(out.regressed).toEqual([]);
  });

  it("counts a failure apart from quality, in either run", () => {
    const out = compareRuns(run([item("a", "right"), item("b", "failed")]), run([item("a", "failed"), item("b", "right")]), right);
    expect(out.failed.sort()).toEqual(["a", "b"]);
    expect(out.regressed).toEqual([]);
    expect(out.recovered).toEqual([]);
  });

  it("skips an item whose question changed, or that only one run has", () => {
    const out = compareRuns(run([item("a", "right", "old"), item("gone", "right")]), run([item("a", "wrong_pick", "new"), item("fresh", "right")]), right);
    expect(out.skipped.sort()).toEqual(["a", "fresh", "gone"]);
    expect(out.regressed).toEqual([]);
  });

  it("refuses to compare another provider, model or api, but lets the prompt differ", () => {
    const base = run([item("a", "right")], { model: "m1", api: "decisions", promptHash: "p1" });
    expect(compareRuns(base, run([item("a", "wrong_pick")], { model: "m2", api: "decisions" }), right)).toMatchObject({ comparable: false, regressed: [] });
    expect(compareRuns(base, run([item("a", "wrong_pick")], { provider: "openrouter", model: "m1", api: "decisions" }), right).comparable).toBe(false);
    expect(compareRuns(base, run([item("a", "wrong_pick")], { model: "m1", api: "decisions", promptHash: "p2" }), right)).toMatchObject({ comparable: true, regressed: ["a"] });
  });

  it("takes the caller's idea of right, for evals with other outcomes", () => {
    const isRight = (outcome: string) => outcome === "member" || outcome === "fallback";
    const out = compareRuns(run([item("a", "member")]), run([item("a", "wrong")]), isRight);
    expect(out.regressed).toEqual(["a"]);
  });
});

describe("run records", () => {
  it("appends one line per run and reads the last back, with the numbers a threshold needs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eval-record-")), "nested", "runs.jsonl");
    appendRunRecord(path, run([item("a", "right")]));
    appendRunRecord(path, run([{ ...item("a", "wrong_pick"), pTop: 0.91, margin: 0.4, latencyMs: 210 }], { ts: "later" }));
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readLastRun(path)).toMatchObject({ ts: "later", items: [{ id: "a", pTop: 0.91, margin: 0.4, latencyMs: 210 }] });
  });

  it("hashes the same value the same way and a changed value differently", () => {
    expect(hashOf({ a: 1 })).toBe(hashOf({ a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});
