// Reads the run records written by eval-record.ts and answers the two questions a single run cannot:
//   1. How much does the same setup disagree with itself? (`stability`) A regression gate that is stricter than this noise
//      cries wolf; its tolerance comes from here.
//   2. Would a (pTop, margin) threshold have held on items it was not fitted on? (`leaveOneOut`) With a few dozen items there
//      is no honest train/test split (a test third of 42 items is 8 items, and 0 wrong in 8 still allows 37% wrong at 95%), so
//      every item takes a turn as the held-out one and the thresholds are chosen from the rest. No extra model calls.
// Pure functions; nothing here reads a file or calls a model.
import type { RecordedItem, RunRecord } from "./eval-record.ts";

type Predicate = (outcome: string) => boolean;

/** Runs are comparable when this is equal: same suite, provider, model, api and instructions. */
export const setupKey = (run: RunRecord): string => [run.suite, run.provider, run.model ?? "", run.api ?? "", run.promptHash ?? ""].join(" | ");

export function groupBySetup(runs: RunRecord[]): Map<string, RunRecord[]> {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) groups.set(setupKey(run), [...(groups.get(setupKey(run)) ?? []), run]);
  return groups;
}

export interface Stability {
  runs: number;
  /** Items seen right or wrong (not failed) in at least two of the runs, with the same content hash. */
  measured: number;
  /** Right in some runs and not right in others, with the same question and the same setup. */
  flipped: Array<{ id: string; right: number; notRight: number }>;
  /** Not right in every run: a stable miss, not noise. */
  alwaysWrong: string[];
  /** Items that failed (network, timeout) at least once; left out of the counts above for that run. */
  failedAtLeastOnce: string[];
}

/** Runs of ONE setup (see `groupBySetup`). An item compares only against runs with the same content hash. */
export function stability(runs: RunRecord[], isRight: Predicate, isFailed: Predicate = (outcome) => outcome === "failed"): Stability {
  const seen = new Map<string, { right: number; notRight: number; failed: boolean }>();
  for (const run of runs) {
    for (const item of run.items) {
      const key = `${item.id}:${item.itemHash}`;
      const entry = seen.get(key) ?? { right: 0, notRight: 0, failed: false };
      if (isFailed(item.outcome)) entry.failed = true;
      else if (isRight(item.outcome)) entry.right += 1;
      else entry.notRight += 1;
      seen.set(key, entry);
    }
  }
  const idOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
  const out: Stability = { runs: runs.length, measured: 0, flipped: [], alwaysWrong: [], failedAtLeastOnce: [] };
  for (const [key, entry] of seen) {
    if (entry.failed) out.failedAtLeastOnce.push(idOf(key));
    if (entry.right + entry.notRight < 2) continue;
    out.measured += 1;
    if (entry.right > 0 && entry.notRight > 0) out.flipped.push({ id: idOf(key), right: entry.right, notRight: entry.notRight });
    else if (entry.notRight > 0) out.alwaysWrong.push(idOf(key));
  }
  return out;
}

/** One answer of the model that carries what a threshold looks at. */
export interface Observation {
  id: string;
  outcome: string;
  pTop: number;
  margin: number;
}

/** The picks in the runs, with their numbers. Records from before `answer` existed, and items without numbers, are counted apart. */
export function pickObservations(runs: RunRecord[]): { picks: Observation[]; withoutAnswer: number } {
  const picks: Observation[] = [];
  let withoutAnswer = 0;
  for (const run of runs) {
    for (const item of run.items as RecordedItem[]) {
      if (item.pTop === undefined || item.margin === undefined) continue;
      if (item.answer === undefined) { withoutAnswer += 1; continue; }
      if (item.answer === "pick") picks.push({ id: item.id, outcome: item.outcome, pTop: item.pTop, margin: item.margin });
    }
  }
  return { picks, withoutAnswer };
}

export interface Thresholds {
  pMin: number;
  mMin: number;
}

export const DEFAULT_GRID: Thresholds[] = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99].flatMap((pMin) => [0, 0.1, 0.3, 0.5, 0.8].map((mMin) => ({ pMin, mMin })));

export interface Tally {
  accepted: number;
  wrong: number;
  /** One-sided 95% upper bound on the wrong rate among accepted picks; 1 when nothing was accepted. */
  upper95: number;
}

/**
 * Exact (Clopper-Pearson) one-sided 95% upper bound on an error rate after `wrong` errors in `n` trials: the p at which
 * seeing `wrong` or fewer errors has a 5% chance. About 3/n for zero errors (the eval's "rule of three"), larger otherwise.
 */
export function upperBound95(wrong: number, n: number): number {
  if (n <= 0 || wrong >= n) return 1;
  const cdf = (p: number) => {
    let term = (1 - p) ** n;
    let sum = term;
    for (let i = 0; i < wrong; i += 1) {
      term *= ((n - i) / (i + 1)) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
}

const passes = (observation: Observation, t: Thresholds): boolean => observation.pTop >= t.pMin && observation.margin >= t.mMin;

export function tally(observations: Observation[], t: Thresholds, isRight: Predicate): Tally {
  const accepted = observations.filter((observation) => passes(observation, t));
  const wrong = accepted.filter((observation) => !isRight(observation.outcome)).length;
  return { accepted: accepted.length, wrong, upper95: upperBound95(wrong, accepted.length) };
}

/**
 * The thresholds to use on these observations: of the grid points that accept no wrong pick, the one that accepts the most
 * picks; on a tie the stricter one. Null when no grid point is free of wrong picks (nothing is safe to accept).
 */
export function chooseThresholds(observations: Observation[], isRight: Predicate, grid: Thresholds[] = DEFAULT_GRID): Thresholds | null {
  let best: { t: Thresholds; accepted: number } | null = null;
  for (const t of grid) {
    const result = tally(observations, t, isRight);
    if (result.wrong > 0) continue;
    const stricter = best !== null && t.pMin + t.mMin > best.t.pMin + best.t.mMin;
    if (!best || result.accepted > best.accepted || (result.accepted === best.accepted && stricter)) best = { t, accepted: result.accepted };
  }
  return best?.t ?? null;
}

export interface LeaveOneOut {
  /** Items held out in turn. */
  items: number;
  /** Held-out items on which the thresholds chosen from the other items would have acted. */
  accepted: number;
  /** Of those, how many would have been acted on wrongly: the honest error count of choosing thresholds this way. */
  wrong: number;
  upper95: number;
  /** Items the thresholds chosen without them would have wrongly acted on. */
  wrongItems: string[];
  /** Held-out items for which no grid point was free of wrong picks, so nothing was accepted. */
  noSafeThreshold: number;
}

/**
 * Each item takes a turn as the held-out one: thresholds are chosen from the picks of every other item (all its repeats are
 * held out together; repeats of one item are not independent evidence), then applied to the held-out item's picks.
 */
export function leaveOneOut(observations: Observation[], isRight: Predicate, grid: Thresholds[] = DEFAULT_GRID): LeaveOneOut {
  const ids = [...new Set(observations.map((observation) => observation.id))];
  const out: LeaveOneOut = { items: ids.length, accepted: 0, wrong: 0, upper95: 1, wrongItems: [], noSafeThreshold: 0 };
  for (const id of ids) {
    const chosen = chooseThresholds(observations.filter((observation) => observation.id !== id), isRight, grid);
    if (!chosen) { out.noSafeThreshold += 1; continue; }
    // Counted per item, not per repeat: five runs of one item are one item's worth of evidence, so it is accepted if any of its
    // picks gets through and wrong if any pick that gets through is wrong.
    const held = tally(observations.filter((observation) => observation.id === id), chosen, isRight);
    if (held.accepted > 0) out.accepted += 1;
    if (held.wrong > 0) { out.wrong += 1; out.wrongItems.push(id); }
  }
  out.upper95 = upperBound95(out.wrong, out.accepted);
  return out;
}
