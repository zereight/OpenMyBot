// Offline deterministic memory eval gate (no model calls, isolated temp data dir).
// Usage:
//   node --experimental-strip-types evals/memory/run-memory-eval.ts [--out report.json] [--compare base.json]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareReports,
  scoreCase,
  summarize,
  type MemoryCaseResult,
  type MemoryEvalCase,
  type MemoryEvalReport,
} from "./score.ts";

function parseArgs(argv: readonly string[]): { out?: string; compare?: string; casesPath: string } {
  let out: string | undefined;
  let compare: string | undefined;
  let casesPath = new URL("./cases.json", import.meta.url).pathname;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) out = argv[(i += 1)];
    else if (arg === "--compare" && argv[i + 1]) compare = argv[(i += 1)];
    else if (arg === "--cases" && argv[i + 1]) casesPath = argv[(i += 1)];
  }
  return { out, compare, casesPath };
}

export function extractTopicIndexChars(promptText: string): number {
  const marker = "\n\nYour topic notes (";
  const at = promptText.indexOf(marker);
  if (at === -1) return 0;
  const headerEnd = promptText.indexOf(":\n", at);
  if (headerEnd === -1) return 0;
  return promptText.slice(headerEnd + 2).length;
}

export async function runMemoryEval(cases: readonly MemoryEvalCase[]): Promise<MemoryEvalReport> {
  const { closeMessageDb } = await import("../../server/message-db.ts");
  const { buildRecall } = await import("../../server/recall.ts");
  const { ensureWorkspace, memorySystemPrompt, writeMemoryFile, writeMemoryTopic } = await import("../../server/workspace.ts");

  const results: MemoryCaseResult[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const spec = cases[i]!;
    const botId = `eval-memory-${i}-${spec.id.replace(/[^a-z0-9-]/gi, "").slice(0, 32)}`;
    ensureWorkspace(botId);
    writeMemoryFile(botId, spec.memoryMd);
    for (let n = 0; n < (spec.generateTopics ?? 0); n += 1) {
      const idx = String(n).padStart(2, "0");
      writeMemoryTopic(botId, `a-topic-${idx}.md`, `---\ntitle: Topic ${idx}\n---\n- Regular note ${idx}.\n`);
    }
    for (let n = 0; n < (spec.generateFixTopics ?? 0); n += 1) {
      const idx = String(n).padStart(2, "0");
      writeMemoryTopic(
        botId,
        `z-fix-${idx}.md`,
        `---\ntitle: Fix ${idx}\nsymptom: service failure case ${idx} on startup\n---\n## What worked\nRestart service ${idx}.\n`,
      );
    }
    for (const [name, content] of Object.entries(spec.topics)) {
      writeMemoryTopic(botId, name, content);
    }
    const promptText = memorySystemPrompt(botId, spec.promptOpts ?? { managedWrites: true, fileTools: true });
    const recallText = spec.query
      ? (buildRecall({ botId, message: spec.query, threadIds: [], label: () => "", author: () => "" })?.text ?? "")
      : "";
    results.push(scoreCase(spec, { recallText, promptText, indexChars: extractTopicIndexChars(promptText) }));
  }
  closeMessageDb();
  return summarize(results);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tempRoot = mkdtempSync(join(tmpdir(), "omb-memory-eval-"));
  process.env.HOME = tempRoot;
  process.env.USERPROFILE = tempRoot;
  try {
    const cases = JSON.parse(readFileSync(args.casesPath, "utf8")) as MemoryEvalCase[];
    const report = await runMemoryEval(cases);
    for (const r of report.results) {
      const status = r.passed ? "PASS" : "FAIL";
      const detail = r.failures.length ? ` — ${r.failures.join("; ")}` : "";
      console.log(`[${status}] ${r.id} (${r.category}, prompt=${r.promptBytes}B, index=${r.indexChars}c)${detail}`);
    }
    console.log(
      `\nSummary: ${report.passed}/${report.total} passed (${Math.round(report.passRate * 100)}%), avgPromptBytes=${report.avgPromptBytes}`,
    );
    if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (args.compare) {
      const base = JSON.parse(readFileSync(args.compare, "utf8")) as MemoryEvalReport;
      const cmp = compareReports(base, report);
      console.log(
        `Gate (${cmp.adopted ? "ADOPT" : "REJECT"}): base=${cmp.basePassed}/${base.total} -> candidate=${cmp.candidatePassed}/${report.total}, ` +
          `improvements=[${cmp.improvements.join(", ")}], regressions=[${cmp.regressions.join(", ")}], ` +
          `avgPromptDelta=${cmp.promptBytesDelta >= 0 ? "+" : ""}${cmp.promptBytesDelta}B (max +${cmp.maxPromptDelta}B)`,
      );
      if (!cmp.adopted) {
        console.error(`Gate rejected: ${cmp.reasons.join("; ")}`);
        process.exitCode = 1;
      }
    } else if (report.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
