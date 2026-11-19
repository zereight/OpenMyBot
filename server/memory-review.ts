// Local-only deterministic memory review: finds repeated tool failures and memory hygiene issues
// and writes proposal-only markdown outside memory/ so nothing is auto-applied or recalled.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { memoryOverview, type MemoryOverview } from "./memory-store.ts";
import { attentionRows, type AttentionRow } from "./message-db.ts";
import { redactSecretsInText } from "./redact.ts";
import { ensureWorkspace, memoryDate, workspaceDir } from "./workspace.ts";

export const REVIEW_DIR = "memory-review";
export const DEFAULT_LOOKBACK_DAYS = 14;
export const STALE_TOPIC_DAYS = 60;
export const OVERSIZED_TOPIC_BYTES = 12 * 1024;
export const CAPACITY_WARN_RATIO = 0.8;
export const MAX_FAILURE_PROPOSALS = 15;

export interface RepeatedToolFailure {
  tool: string;
  signature: string;
  count: number;
  threadIds: string[];
  lastAt: number;
}

export interface MemoryHygieneItem {
  kind: "memory-capacity" | "oversized-topic" | "stale-topic";
  path: string;
  detail: string;
  suggestion: string;
}

export interface MemoryReviewReport {
  botId: string;
  generatedOn: string;
  lookbackDays: number;
  repeatedFailures: RepeatedToolFailure[];
  hygiene: MemoryHygieneItem[];
}

export interface MemoryReviewOptions {
  threadIds?: ReadonlySet<string>;
  lookbackDays?: number;
  staleDays?: number;
  oversizedBytes?: number;
  now?: Date;
}

/** Normalizes volatile numbers, hex ids, paths, and whitespace so repeated failures group reliably. */
export function normalizeErrorSignature(raw: string | null | undefined): string {
  if (!raw) return "unknown error";
  const redacted = redactSecretsInText(raw);
  const firstLine = redacted.split(/\r?\n/).find((line) => line.trim()) ?? redacted;
  return firstLine
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "unknown error";
}

export function findRepeatedToolFailures(
  rows: readonly AttentionRow[],
  threadIds?: ReadonlySet<string>,
): RepeatedToolFailure[] {
  const groups = new Map<string, { tool: string; signature: string; count: number; threads: Set<string>; lastAt: number }>();
  for (const row of rows) {
    if (row.kind !== "activity" || !row.name) continue;
    if (threadIds && !threadIds.has(row.threadId)) continue;
    const signature = normalizeErrorSignature(row.output);
    const key = `${row.name}::${signature.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.threads.add(row.threadId);
      if (row.at > existing.lastAt) existing.lastAt = row.at;
    } else {
      groups.set(key, {
        tool: row.name,
        signature,
        count: 1,
        threads: new Set([row.threadId]),
        lastAt: row.at,
      });
    }
  }
  return [...groups.values()]
    .filter((g) => g.threads.size >= 2 || g.count >= 3)
    .map((g) => ({
      tool: g.tool,
      signature: g.signature,
      count: g.count,
      threadIds: [...g.threads].sort(),
      lastAt: g.lastAt,
    }))
    .sort((a, b) => b.threadIds.length - a.threadIds.length || b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, MAX_FAILURE_PROPOSALS);
}

export function findMemoryHygieneIssues(
  overview: MemoryOverview,
  opts: { nowMs: number; staleDays: number; oversizedBytes: number },
): MemoryHygieneItem[] {
  const items: MemoryHygieneItem[] = [];
  const lineRatio = overview.index.lines / overview.index.maxLines;
  const byteRatio = overview.index.bytes / overview.index.maxBytes;
  if (overview.index.truncated || lineRatio >= CAPACITY_WARN_RATIO || byteRatio >= CAPACITY_WARN_RATIO) {
    items.push({
      kind: "memory-capacity",
      path: "MEMORY.md",
      detail: `${overview.index.lines}/${overview.index.maxLines} lines, ${overview.index.bytes}/${overview.index.maxBytes} bytes`,
      suggestion: "Move task-specific procedures or long reference lists into memory/<topic>.md so core facts stay under the cap.",
    });
  }
  const staleCutoff = opts.nowMs - opts.staleDays * 86_400_000;
  for (const topic of overview.topics) {
    if (topic.name === "archive.md") continue;
    if (topic.bytes >= opts.oversizedBytes) {
      items.push({
        kind: "oversized-topic",
        path: topic.path,
        detail: `${topic.bytes} bytes (threshold ${opts.oversizedBytes} bytes)`,
        suggestion: "Split into smaller focused topic notes with clear frontmatter title/aliases so recall stays sharp.",
      });
    }
    if (topic.modifiedAt > 0 && topic.modifiedAt < staleCutoff) {
      const ageDays = Math.floor((opts.nowMs - topic.modifiedAt) / 86_400_000);
      items.push({
        kind: "stale-topic",
        path: topic.path,
        detail: `unmodified for ${ageDays} days`,
        suggestion: "Review whether this note is still accurate; update or archive it if obsolete.",
      });
    }
  }
  return items;
}

export function buildMemoryReview(botId: string, opts: MemoryReviewOptions = {}): MemoryReviewReport {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const staleDays = opts.staleDays ?? STALE_TOPIC_DAYS;
  const oversizedBytes = opts.oversizedBytes ?? OVERSIZED_TOPIC_BYTES;
  const since = now.getTime() - lookbackDays * 86_400_000;

  const rows = attentionRows(since);
  const repeatedFailures = findRepeatedToolFailures(rows, opts.threadIds);
  const overview = memoryOverview(botId);
  const hygiene = findMemoryHygieneIssues(overview, { nowMs: now.getTime(), staleDays, oversizedBytes });

  return {
    botId,
    generatedOn: memoryDate(now),
    lookbackDays,
    repeatedFailures,
    hygiene,
  };
}

export function renderMemoryReviewMarkdown(report: MemoryReviewReport): string {
  const lines: string[] = [
    `# Memory Review Proposals (${report.generatedOn})`,
    "",
    `> Proposal only — nothing in \`MEMORY.md\`, \`memory/\`, or skills was modified automatically.`,
    `> Scope: local SQLite activity and workspace files for bot \`${report.botId}\` (last ${report.lookbackDays} days, zero external requests).`,
    "",
  ];

  lines.push("## 1. Repeated tool failures (candidate fix notes)");
  if (!report.repeatedFailures.length) {
    lines.push("- None detected in this window.");
  } else {
    for (const item of report.repeatedFailures) {
      lines.push(
        `- **${item.tool}** failed ${item.count} times across ${item.threadIds.length} thread(s): \`${item.signature}\``,
      );
      lines.push(
        `  - Evidence threads: ${item.threadIds.slice(0, 5).join(", ")}`,
      );
      lines.push(
        "  - Proposal: If resolved, add a neutral fix note (`memory/fix-<slug>.md`) with Symptom / Cause / What worked / What did not work and why.",
      );
    }
  }

  lines.push("", "## 2. Memory hygiene proposals");
  if (!report.hygiene.length) {
    lines.push("- No capacity, size, or staleness warnings.");
  } else {
    for (const item of report.hygiene) {
      lines.push(`- **${item.path}** (${item.kind}: ${item.detail})`);
      lines.push(`  - Proposal: ${item.suggestion}`);
    }
  }

  lines.push("");
  return redactSecretsInText(lines.join("\n"));
}

/** Writes the proposal report to `<workspace>/memory-review/YYYY-MM-DD.md` without touching `MEMORY.md` or `memory/`. */
export function writeMemoryReviewProposal(
  botId: string,
  report: MemoryReviewReport,
): { filePath: string; markdown: string } {
  ensureWorkspace(botId);
  const dir = join(workspaceDir(botId), REVIEW_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${report.generatedOn}.md`);
  const markdown = renderMemoryReviewMarkdown(report);
  writeFileAtomic(filePath, markdown, { mode: 0o600 });
  return { filePath, markdown };
}
