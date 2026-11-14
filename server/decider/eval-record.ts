// Run records and a regression check for the live decision evals (browser-clicks.eval.test.ts).
//
// A live run costs money and is read once, then forgotten. This writes one JSON line per run to
// evals/reports/runs/ (git-ignored), with the per-item numbers a threshold needs (pTop, margin), and compares a run with a
// baseline run you name. Local tooling: live evals do not run in CI, so nothing here fails a build.
//
// Rules, each one a way the comparison could mislead:
// - Runs compare only when provider, model and api match; a different model is a different experiment, not a regression.
//   The prompt hash is allowed to differ: that is the change under test.
// - An item compares only when its content hash (intent, host, candidates, gold) is the same in both runs; a fixed label
//   is a different question.
// - `failed` (network, timeout) is counted apart from quality: it never counts as a regression.
// - The baseline is whatever file you point at. Nothing here overwrites it.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RecordedItem {
  id: string;
  set: string;
  /** Hash of what the question is: change a label or a candidate and the item is no longer comparable. */
  itemHash: string;
  /** Free-form outcome of the eval (`right`, `wrong_pick`, `failed`, …); `isRight` decides which count as good. */
  outcome: string;
  /** What the model said: acted on a control (`pick`) or said nothing fits (`none`). Needed to tell which items a threshold would let through; older records lack it. */
  answer?: "pick" | "none";
  pTop?: number;
  margin?: number;
  latencyMs?: number;
}

export interface RunMeta {
  /** What was run, e.g. `browser-clicks`. */
  suite: string;
  ts: string;
  provider: string;
  model?: string;
  api?: string;
  /** Hash of the instructions the model saw; may differ between baseline and current. */
  promptHash?: string;
  gitSha?: string;
}

export interface RunRecord extends RunMeta {
  items: RecordedItem[];
}

export const hashOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** Appends one run as one JSON line, creating the folder. */
export function appendRunRecord(path: string, record: RunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** Every run in a JSONL file, oldest first. */
export function readRuns(path: string): RunRecord[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as RunRecord);
}

/** The last run in a JSONL file, or null for an empty one. */
export function readLastRun(path: string): RunRecord | null {
  return readRuns(path).at(-1) ?? null;
}

export interface RunComparison {
  /** False when provider, model or api differ: no item is compared. */
  comparable: boolean;
  why?: string;
  /** Right in the baseline, not right now (and not merely failed). */
  regressed: string[];
  /** Not right in the baseline, right now. */
  recovered: string[];
  /** Failed in either run: a transport problem, reported, never a regression. */
  failed: string[];
  /** Right in the baseline and not now, but known to flip between identical runs (see eval-analysis.ts): noise, not a regression. */
  flaky: string[];
  /** Items whose question changed between the runs, or that only one run has. */
  skipped: string[];
}

export function compareRuns(
  baseline: RunRecord,
  current: RunRecord,
  isRight: (outcome: string) => boolean,
  isFailed: (outcome: string) => boolean = (outcome) => outcome === "failed",
  /** Items that flip between runs of one unchanged setup: a drop on one of these is reported as `flaky`, not `regressed`. */
  flaky: ReadonlySet<string> = new Set(),
): RunComparison {
  const empty = { regressed: [], recovered: [], failed: [], flaky: [], skipped: [] };
  for (const key of ["suite", "provider", "model", "api"] as const) {
    if (baseline[key] !== current[key]) return { comparable: false, why: `${key} differs: ${baseline[key] ?? "none"} vs ${current[key] ?? "none"}`, ...empty };
  }
  const before = new Map(baseline.items.map((item) => [item.id, item]));
  const result: RunComparison = { comparable: true, ...empty };
  for (const item of current.items) {
    const was = before.get(item.id);
    if (!was || was.itemHash !== item.itemHash) { result.skipped.push(item.id); continue; }
    if (isFailed(item.outcome) || isFailed(was.outcome)) { result.failed.push(item.id); continue; }
    if (isRight(was.outcome) && !isRight(item.outcome)) (flaky.has(item.id) ? result.flaky : result.regressed).push(item.id);
    else if (!isRight(was.outcome) && isRight(item.outcome)) result.recovered.push(item.id);
  }
  const now = new Set(current.items.map((item) => item.id));
  for (const id of before.keys()) if (!now.has(id)) result.skipped.push(id);
  return result;
}
