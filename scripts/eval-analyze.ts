// Reads the live-eval run records and prints, for each setup (model, api, instructions) that has runs:
//   - how often it disagrees with itself (which items flip between runs of the same setup),
//   - what each (pTop, margin) threshold would have let through on the last run, and
//   - whether thresholds chosen from the other items hold on the one held out (leave-one-out), which is the figure that
//     says if BROWSER_CLICK_THRESHOLDS can be filled in.
// Usage: pnpm eval:analyze [path/to/runs.jsonl]   (default evals/reports/runs/browser-clicks.jsonl)
import { existsSync } from "node:fs";
import { join } from "node:path";

import { chooseThresholds, groupBySetup, leaveOneOut, pickObservations, stability, tally, type Observation } from "../server/decider/eval-analysis.ts";
import { readRuns, type RunRecord } from "../server/decider/eval-record.ts";

const path = process.argv[2] ?? join(import.meta.dirname, "..", "evals", "reports", "runs", "browser-clicks.jsonl");
if (!existsSync(path)) {
  console.error(`no run records at ${path}; run a live eval first (see server/decider/browser-clicks.eval.test.ts)`);
  process.exit(1);
}

const isRight = (outcome: string) => outcome === "right";
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const percentile = (values: number[], p: number) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))] : undefined);

for (const [setup, runs] of groupBySetup(readRuns(path))) {
  const last: RunRecord = runs[runs.length - 1]!;
  console.log(`\n== ${setup}\n   ${runs.length} run(s), ${runs.map((run) => `${run.items.filter((item) => isRight(item.outcome)).length}/${run.items.length} right`).join(", ")}`);

  const steady = stability(runs, isRight);
  if (runs.length < 2) console.log("   stability: needs at least 2 runs of the same setup");
  else {
    console.log(`   stability: ${steady.flipped.length} of ${steady.measured} items flipped between runs${steady.flipped.length ? ` (${steady.flipped.map((entry) => `${entry.id} ${entry.right}/${entry.right + entry.notRight} right`).join(", ")})` : ""}`);
    if (steady.alwaysWrong.length) console.log(`   never right: ${steady.alwaysWrong.join(", ")}`);
    if (steady.failedAtLeastOnce.length) console.log(`   failed at least once (network/timeout): ${steady.failedAtLeastOnce.join(", ")}`);
  }

  const latencies = runs.flatMap((run) => run.items.flatMap((item) => (item.latencyMs === undefined ? [] : [item.latencyMs])));
  if (latencies.length) console.log(`   latency: p50 ${percentile(latencies, 0.5)} ms, p95 ${percentile(latencies, 0.95)} ms over ${latencies.length} answers`);

  const { picks, withoutAnswer } = pickObservations(runs);
  if (withoutAnswer) console.log(`   ${withoutAnswer} answer(s) in older records do not say pick or none and are left out of the threshold figures`);
  const lastPicks: Observation[] = pickObservations([last]).picks;
  if (!picks.length) {
    console.log("   thresholds: no pick records with numbers yet");
    continue;
  }
  console.log(`   thresholds, last run (${lastPicks.length} picks):`);
  for (const pMin of [0.5, 0.8, 0.9, 0.95, 0.98]) {
    const result = tally(lastPicks, { pMin, mMin: 0 }, isRight);
    console.log(`     pTop>=${pMin}: ${result.accepted} accepted, ${result.wrong} wrong, wrong rate <= ${pct(result.upper95)} (95%)`);
  }
  const chosen = chooseThresholds(picks, isRight);
  const loo = leaveOneOut(picks, isRight);
  console.log(`   chosen on all runs: ${chosen ? `pTop>=${chosen.pMin}, margin>=${chosen.mMin}` : "none is free of wrong picks"}`);
  console.log(`   leave-one-out over ${loo.items} items: ${loo.accepted} accepted, ${loo.wrong} wrong${loo.wrongItems.length ? ` (${loo.wrongItems.join(", ")})` : ""}, wrong rate <= ${pct(loo.upper95)} (95%)${loo.noSafeThreshold ? `, ${loo.noSafeThreshold} item(s) with no safe threshold` : ""}`);
}
