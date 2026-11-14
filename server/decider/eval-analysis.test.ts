import { describe, expect, it } from "vitest";

import { chooseThresholds, groupBySetup, leaveOneOut, pickObservations, setupKey, stability, tally, upperBound95, type Observation } from "./eval-analysis.ts";
import type { RecordedItem, RunRecord } from "./eval-record.ts";

const right = (outcome: string) => outcome === "right";
const item = (id: string, outcome: string, over: Partial<RecordedItem> = {}): RecordedItem => ({ id, set: "s", itemHash: `h-${id}`, outcome, ...over });
const run = (items: RecordedItem[], over: Partial<RunRecord> = {}): RunRecord => ({ suite: "browser-clicks", ts: "t", provider: "openrouter", model: "m", api: "decisions", promptHash: "p", items, ...over });
const obs = (id: string, outcome: string, pTop: number, margin = 0.5): Observation => ({ id, outcome, pTop, margin });

describe("groupBySetup", () => {
  it("puts runs of the same model and instructions together and splits on a changed prompt", () => {
    const groups = groupBySetup([run([]), run([]), run([], { promptHash: "p2" }), run([], { model: "other" })]);
    expect([...groups.values()].map((runs) => runs.length).sort()).toEqual([1, 1, 2]);
    expect(setupKey(run([]))).toBe(setupKey(run([item("x", "right")])));
  });
});

describe("stability", () => {
  it("finds the items that are right in some runs and not in others", () => {
    const out = stability([run([item("a", "right"), item("b", "right")]), run([item("a", "wrong_pick"), item("b", "right")]), run([item("a", "right"), item("b", "right")])], right);
    expect(out).toMatchObject({ runs: 3, measured: 2, flipped: [{ id: "a", right: 2, notRight: 1 }], alwaysWrong: [] });
  });

  it("separates a stable miss from noise", () => {
    const out = stability([run([item("a", "wrong_pick")]), run([item("a", "false_none")])], right);
    expect(out.alwaysWrong).toEqual(["a"]);
    expect(out.flipped).toEqual([]);
  });

  it("leaves a failed run out of an item's tally and lists the item", () => {
    const out = stability([run([item("a", "right")]), run([item("a", "failed")]), run([item("a", "right")])], right);
    expect(out).toMatchObject({ measured: 1, flipped: [], failedAtLeastOnce: ["a"] });
    // One usable observation is not a measurement of stability.
    expect(stability([run([item("a", "right")]), run([item("a", "failed")])], right).measured).toBe(0);
  });

  it("does not compare an item across a changed question", () => {
    const out = stability([run([item("a", "right", { itemHash: "old" })]), run([item("a", "wrong_pick", { itemHash: "new" })])], right);
    expect(out).toMatchObject({ measured: 0, flipped: [] });
  });
});

describe("upperBound95", () => {
  it("is close to the rule of three for zero errors, and larger with errors", () => {
    expect(upperBound95(0, 42)).toBeCloseTo(1 - 0.05 ** (1 / 42), 6);
    expect(upperBound95(0, 100)).toBeCloseTo(0.0295, 3);
    expect(upperBound95(1, 42)).toBeGreaterThan(upperBound95(0, 42));
    // Known value: 1 error in 20 trials, one-sided 95% Clopper-Pearson upper bound.
    expect(upperBound95(1, 20)).toBeCloseTo(0.2161, 3);
  });

  it("says nothing is known when nothing was accepted or everything was wrong", () => {
    expect(upperBound95(0, 0)).toBe(1);
    expect(upperBound95(3, 3)).toBe(1);
  });
});

describe("tally and chooseThresholds", () => {
  const picks = [obs("a", "right", 0.99), obs("b", "right", 0.97), obs("c", "right", 0.9), obs("d", "wrong_pick", 0.92, 0.2), obs("e", "right", 0.6)];

  it("counts what a threshold lets through and how many of those are wrong", () => {
    expect(tally(picks, { pMin: 0.9, mMin: 0 }, right)).toMatchObject({ accepted: 4, wrong: 1 });
    expect(tally(picks, { pMin: 0.95, mMin: 0 }, right)).toMatchObject({ accepted: 2, wrong: 0 });
    expect(tally(picks, { pMin: 0.9, mMin: 0.3 }, right)).toMatchObject({ accepted: 3, wrong: 0 });
  });

  it("takes the grid point that accepts the most with no wrong pick", () => {
    const grid = [{ pMin: 0.95, mMin: 0 }, { pMin: 0.9, mMin: 0.3 }, { pMin: 0.99, mMin: 0 }, { pMin: 0.9, mMin: 0 }];
    // 0.9/0.3 accepts a, b, c (3); 0.95/0 accepts a, b (2); 0.9/0 lets the wrong pick through.
    expect(chooseThresholds(picks, right, grid)).toEqual({ pMin: 0.9, mMin: 0.3 });
  });

  it("takes the stricter point on a tie", () => {
    const same = [obs("a", "right", 0.99, 0.9), obs("b", "right", 0.98, 0.9)];
    expect(chooseThresholds(same, right, [{ pMin: 0.5, mMin: 0 }, { pMin: 0.9, mMin: 0.5 }, { pMin: 0.7, mMin: 0 }])).toEqual({ pMin: 0.9, mMin: 0.5 });
  });

  it("returns null when every grid point lets a wrong pick through", () => {
    expect(chooseThresholds([obs("x", "wrong_pick", 0.99, 0.99)], right, [{ pMin: 0, mMin: 0 }, { pMin: 0.5, mMin: 0.5 }])).toBeNull();
  });
});

describe("leaveOneOut", () => {
  it("shows a threshold that held on items it was not fitted on", () => {
    // Wrong picks are the least sure ones everywhere, so thresholds fitted without one still keep the other out.
    const picks = [
      ...["a", "b", "c", "d", "e", "f"].map((id) => obs(id, "right", 0.99, 0.9)),
      obs("w1", "wrong_pick", 0.6, 0.1),
      obs("w2", "wrong_pick", 0.55, 0.05),
    ];
    const out = leaveOneOut(picks, right, [{ pMin: 0, mMin: 0 }, { pMin: 0.9, mMin: 0.5 }]);
    expect(out).toMatchObject({ items: 8, wrong: 0, wrongItems: [], noSafeThreshold: 0 });
    expect(out.accepted).toBe(6);
  });

  it("shows a single wrong pick that nothing learned from the others could have excluded", () => {
    const picks = [obs("a", "right", 0.97, 0.9), obs("b", "right", 0.97, 0.9), obs("c", "right", 0.9, 0.9), obs("d", "right", 0.9, 0.9), obs("w", "wrong_pick", 0.93, 0.8)];
    const out = leaveOneOut(picks, right, [{ pMin: 0, mMin: 0 }, { pMin: 0.95, mMin: 0 }]);
    // With w held out, the loose point accepts all four right picks and the strict one only two, so the loose one is chosen
    // and w gets through. With any other item held out, w is in the data and the strict point is the only safe one.
    expect(out).toMatchObject({ items: 5, accepted: 3, wrong: 1, wrongItems: ["w"] });
    expect(out.upper95).toBeGreaterThan(0.5);
  });

  it("holds all repeats of an item out together and counts the item once", () => {
    const picks = [obs("a", "right", 0.99), obs("a", "right", 0.98), obs("a", "right", 0.97), obs("b", "right", 0.99)];
    const out = leaveOneOut(picks, right, [{ pMin: 0, mMin: 0 }]);
    expect(out).toMatchObject({ items: 2, accepted: 2, wrong: 0 });
  });

  it("reports items for which no threshold is safe, and accepts nothing for them", () => {
    const out = leaveOneOut([obs("a", "wrong_pick", 0.9), obs("b", "wrong_pick", 0.9), obs("c", "right", 0.9)], right, [{ pMin: 0, mMin: 0 }]);
    expect(out).toMatchObject({ items: 3, accepted: 0, wrong: 0, noSafeThreshold: 3 });
  });
});

describe("pickObservations", () => {
  it("keeps picks that have numbers and counts records from before `answer` existed", () => {
    const out = pickObservations([
      run([
        item("a", "right", { answer: "pick", pTop: 0.9, margin: 0.4 }),
        item("b", "right", { answer: "none", pTop: 0.8, margin: 0.3 }),
        item("c", "right", { pTop: 0.9, margin: 0.4 }),
        item("d", "failed"),
      ]),
    ]);
    expect(out.picks).toEqual([{ id: "a", outcome: "right", pTop: 0.9, margin: 0.4 }]);
    expect(out.withoutAnswer).toBe(1);
  });
});
