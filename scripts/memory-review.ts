// Local-only CLI to generate proposal-only memory review reports.
// Usage:
//   node --experimental-strip-types scripts/memory-review.ts --bot <botId> [--days 14] [--write] [--all-threads]
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../server/config.ts";
import {
  buildMemoryReview,
  DEFAULT_LOOKBACK_DAYS,
  renderMemoryReviewMarkdown,
  writeMemoryReviewProposal,
} from "../server/memory-review.ts";
import { closeMessageDb } from "../server/message-db.ts";

function parseArgs(argv: readonly string[]): { botId: string; days: number; write: boolean; allThreads: boolean } {
  let botId = "";
  let days = DEFAULT_LOOKBACK_DAYS;
  let write = false;
  let allThreads = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bot" && argv[i + 1]) botId = argv[(i += 1)]!;
    else if (arg === "--days" && argv[i + 1]) days = Number(argv[(i += 1)]) || DEFAULT_LOOKBACK_DAYS;
    else if (arg === "--write") write = true;
    else if (arg === "--all-threads") allThreads = true;
  }
  return { botId, days, write, allThreads };
}

function botThreadIds(botId: string): Set<string> | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, "state.json"), "utf8")) as {
      bots?: Array<{ id?: string; threadId?: string; tasks?: Array<{ threadId?: string }> }>;
    };
    const bot = raw.bots?.find((b) => b.id === botId);
    if (!bot) return new Set();
    const ids = new Set<string>();
    if (bot.threadId) ids.add(bot.threadId);
    for (const task of bot.tasks ?? []) {
      if (task.threadId) ids.add(task.threadId);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function main(): void {
  const { botId, days, write, allThreads } = parseArgs(process.argv.slice(2));
  if (!botId) {
    console.error("Usage: node --experimental-strip-types scripts/memory-review.ts --bot <botId> [--days 14] [--write] [--all-threads]");
    process.exitCode = 1;
    return;
  }
  try {
    const threadIds = allThreads ? undefined : botThreadIds(botId);
    const report = buildMemoryReview(botId, { lookbackDays: days, threadIds });
    if (write) {
      const { filePath } = writeMemoryReviewProposal(botId, report);
      console.log(
        `Wrote proposal report to ${filePath} (${report.repeatedFailures.length} failure pattern(s), ${report.hygiene.length} hygiene item(s))`,
      );
    } else {
      console.log(renderMemoryReviewMarkdown(report));
    }
  } finally {
    closeMessageDb();
  }
}

main();
