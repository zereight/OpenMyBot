import { readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../../server/config.ts";
import { closeMessageDb } from "../../server/message-db.ts";
import { WORKSPACES_DIR } from "../../server/workspace.ts";
import { runMemoryEval } from "./run-memory-eval.ts";
import { compareReports, scoreCase, summarize, type MemoryEvalCase } from "./score.ts";

describe("memory eval scorer and adoption gate", () => {
  it("flags missing expected text, forbidden text, and index cap overflow", () => {
    const spec: MemoryEvalCase = {
      id: "sample",
      category: "test",
      description: "sample",
      memoryMd: "",
      topics: {},
      expectRecallContain: ["memory/fix-a.md"],
      expectRecallAbsent: ["memory/fix-b.md"],
      expectPromptContain: ["expected-guidance"],
      expectPromptAbsent: ["forbidden-guidance"],
      maxIndexChars: 100,
    };
    const bad = scoreCase(spec, {
      recallText: "memory/fix-b.md",
      promptText: "forbidden-guidance",
      indexChars: 150,
    });
    expect(bad.passed).toBe(false);
    expect(bad.failures).toHaveLength(5);

    const good = scoreCase(spec, {
      recallText: "memory/fix-a.md",
      promptText: "expected-guidance",
      indexChars: 80,
    });
    expect(good.passed).toBe(true);
    expect(good.failures).toEqual([]);
  });

  it("rejects pass->fail regressions and prompt bloat above budget", () => {
    const base = summarize([
      { id: "a", category: "c", passed: true, failures: [], promptBytes: 1000, indexChars: 100 },
      { id: "b", category: "c", passed: false, failures: ["x"], promptBytes: 1000, indexChars: 100 },
    ]);
    const improved = summarize([
      { id: "a", category: "c", passed: true, failures: [], promptBytes: 1350, indexChars: 120 },
      { id: "b", category: "c", passed: true, failures: [], promptBytes: 1350, indexChars: 120 },
    ]);
    expect(compareReports(base, improved)).toMatchObject({
      adopted: true,
      improvements: ["b"],
      regressions: [],
      promptBytesDelta: 350,
    });

    const regressed = summarize([
      { id: "a", category: "c", passed: false, failures: ["broke"], promptBytes: 1100, indexChars: 100 },
      { id: "b", category: "c", passed: true, failures: [], promptBytes: 1100, indexChars: 100 },
    ]);
    expect(compareReports(base, regressed).adopted).toBe(false);

    const bloated = summarize([
      { id: "a", category: "c", passed: true, failures: [], promptBytes: 2500, indexChars: 100 },
      { id: "b", category: "c", passed: true, failures: [], promptBytes: 2500, indexChars: 100 },
    ]);
    expect(compareReports(base, bloated, 800).adopted).toBe(false);
  });
});

describe("memory eval 10-case fixture suite", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("passes all 10 deterministic recall, overflow, and guidance guard cases", async () => {
    const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as MemoryEvalCase[];
    expect(cases).toHaveLength(10);
    const report = await runMemoryEval(cases);
    expect(report.results.filter((r) => !r.passed)).toEqual([]);
    expect(report.passed).toBe(10);
  });
});
