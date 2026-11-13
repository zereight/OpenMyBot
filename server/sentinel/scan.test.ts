import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { runScan } from "./scan.ts";
import { readIssues, readState, STATE_FILE, STATE_VERSION } from "./store.ts";
import { fixtureDataDir, turnCompleted, type FixtureDataDir } from "./testing.ts";

describe("sentinel scan", () => {
  let dir: string;
  let out: string;
  let fixture: FixtureDataDir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-sentinel-scan-"));
    out = join(dir, "out");
    fixture = fixtureDataDir(join(dir, "data"), [{ id: "b1", name: "Probe", threadId: "t1" }]);
  });
  afterEach(() => {
    fixture.close();
    removeTempDir(dir);
  });

  it("reports a wait that crosses the threshold while no source file changes", () => {
    const enqueued = Date.UTC(2026, 9, 14, 12);
    fixture.assignment({ id: "a1", status: "queued", botId: "b1", threadId: "t1", events: [{ kind: "enqueued", at: enqueued }] });
    const options = { dataDir: fixture.dataDir, out, queueWaitMs: 300_000 };

    const early = runScan({ ...options, now: enqueued + 60_000 });
    expect(early.scanned).toBe(true);
    expect(early.touched.filter((issue) => issue.kind === "queue_wait")).toEqual([]);

    expect(runScan({ ...options, now: enqueued + 120_000 }).scanned).toBe(false);

    const late = runScan({ ...options, now: enqueued + 360_000 });
    expect(late.scanned).toBe(true);
    expect(late.touched.map((issue) => issue.kind)).toEqual(["queue_wait"]);

    expect(runScan({ ...options, now: enqueued + 420_000 }).scanned).toBe(false);
  });

  it("does not count an occurrence again after reading a state file from another version", () => {
    const at = Date.UTC(2026, 9, 14, 12);
    fixture.activity({ threadId: "t1", id: "m1", at, name: "mcp__agents__send", ok: false, output: "no layer 90" });
    const options = { dataDir: fixture.dataDir, out };
    expect(runScan({ ...options, now: at + 60_000 }).added).toBe(1);
    const state = JSON.parse(readFileSync(join(out, STATE_FILE), "utf8"));
    writeFileSync(join(out, STATE_FILE), JSON.stringify({ ...state, version: STATE_VERSION - 1, seen: { "tool:m1": at } }));
    fixture.activity({ threadId: "t1", id: "m2", at: at + 90_000, name: "mcp__agents__send", ok: false, output: "no layer 91" });

    expect(runScan({ ...options, now: at + 120_000 }).added).toBe(1);
    expect([...readIssues(out).values()].map((issue) => issue.count)).toEqual([2]);
    fixture.activity({ threadId: "t1", id: "m3", at: at + 150_000, name: "mcp__agents__send", ok: false, output: "no layer 92" });

    expect(runScan({ ...options, now: at + 180_000 }).added).toBe(1);
    expect([...readIssues(out).values()].map((issue) => issue.count)).toEqual([3]);
  });

  it("remembers a bot's usual cost across scans and flags a later jump", () => {
    const start = Date.UTC(2026, 9, 14, 12);
    const costs = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    appendFileSync(join(fixture.dataDir, "events", "t1.ndjson"), `${costs.map((cost, i) => turnCompleted({ eventId: `e${i}`, threadId: "t1", turnId: `u${i}`, at: start + i * 1000, cost })).join("\n")}\n`);
    const options = { dataDir: fixture.dataDir, out };

    expect(runScan({ ...options, now: start + 60_000 }).added).toBe(0);
    // the first scan of a log starts near its end and skips the partial line it lands in, so the baseline keeps the tail
    expect(readState(out).costs.b1).toEqual(expect.arrayContaining(costs.slice(-4)));

    appendFileSync(join(fixture.dataDir, "events", "t1.ndjson"), `${turnCompleted({ eventId: "e9", threadId: "t1", turnId: "u9", at: start + 120_000, cost: 3 })}\n`);
    const spiked = runScan({ ...options, now: start + 180_000 });
    expect(spiked.touched.map((issue) => issue.kind)).toEqual(["cost_spike"]);
    expect(spiked.touched[0]).toMatchObject({ count: 1, evidenceRef: { source: "events", id: "e9" }, title: "a turn cost $3.00, over 5× this bot's usual $0.20" });

    // a spike is left out of the usual, so the same cost again is another spike of the same issue
    appendFileSync(join(fixture.dataDir, "events", "t1.ndjson"), `${turnCompleted({ eventId: "e10", threadId: "t1", turnId: "u10", at: start + 240_000, cost: 3 })}\n`);
    const again = runScan({ ...options, now: start + 300_000 });
    expect(again.added).toBe(1);
    expect(again.touched.map((issue) => [issue.kind, issue.count])).toEqual([["cost_spike", 2]]);
    expect(readState(out).costs.b1).not.toContain(3);
  });
});
