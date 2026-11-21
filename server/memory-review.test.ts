import { existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  buildMemoryReview,
  findRepeatedToolFailures,
  normalizeErrorSignature,
  renderMemoryReviewMarkdown,
  writeMemoryReviewProposal,
} from "./memory-review.ts";
import { appendMessage, closeMessageDb } from "./message-db.ts";
import { buildRecall } from "./recall.ts";
import { ensureWorkspace, writeMemoryFile, writeMemoryTopic, WORKSPACES_DIR } from "./workspace.ts";

const BOT = "bot-memory-review";

describe("local memory review proposals", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("groups repeated failed tool calls across threads, ignores one-offs, and redacts secrets", () => {
    const now = new Date("2026-11-19T10:00:00Z");
    const t1 = now.getTime() - 3_600_000;
    const t2 = now.getTime() - 1_800_000;

    appendMessage("thread-a", {
      id: "m1",
      role: "assistant",
      kind: "activity",
      at: t1,
      text: "",
      tool: {
        name: "Bash",
        ok: false,
        output: "EADDRINUSE port 8799 with token sk-ant-api03-secretvalue12345678901234567890",
      },
    } as never);
    appendMessage("thread-b", {
      id: "m2",
      role: "assistant",
      kind: "activity",
      at: t2,
      text: "",
      tool: {
        name: "Bash",
        ok: false,
        output: "EADDRINUSE port 8800 with token sk-ant-api03-anothersecret12345678901234567",
      },
    } as never);
    // One-off failure in a single thread must not be reported as a repeated pattern.
    appendMessage("thread-c", {
      id: "m3",
      role: "assistant",
      kind: "activity",
      at: t2,
      text: "",
      tool: { name: "Read", ok: false, output: "ENOENT missing-file.txt" },
    } as never);

    ensureWorkspace(BOT);
    const report = buildMemoryReview(BOT, {
      now,
      threadIds: new Set(["thread-a", "thread-b", "thread-c"]),
    });
    expect(report.repeatedFailures).toHaveLength(1);
    expect(report.repeatedFailures[0]).toMatchObject({
      tool: "Bash",
      count: 2,
      threadIds: ["thread-a", "thread-b"],
    });
    const md = renderMemoryReviewMarkdown(report);
    expect(md).toContain("EADDRINUSE port <n>");
    expect(md).not.toContain("sk-ant-api03");
    expect(md).toContain("Proposal only");
  });

  it("flags near-capacity MEMORY.md, oversized topics, and stale topics without modifying any memory file", () => {
    const now = new Date("2026-11-19T10:00:00Z");
    ensureWorkspace(BOT);
    const bigMemory = Array.from({ length: 170 }, (_, i) => `- 2026-11-01 · Fact line ${i}`).join("\n");
    writeMemoryFile(BOT, bigMemory);
    writeMemoryTopic(BOT, "huge.md", "x".repeat(13 * 1024));
    writeMemoryTopic(BOT, "old.md", "---\ntitle: Old\n---\n- Legacy note\n");
    const oldPath = join(WORKSPACES_DIR, BOT, "memory", "old.md");
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
    utimesSync(oldPath, ninetyDaysAgo, ninetyDaysAgo);

    const report = buildMemoryReview(BOT, { now, threadIds: new Set() });
    const kinds = report.hygiene.map((h) => `${h.kind}:${h.path}`);
    expect(kinds).toContain("memory-capacity:MEMORY.md");
    expect(kinds).toContain("oversized-topic:memory/huge.md");
    expect(kinds).toContain("stale-topic:memory/old.md");

    const { filePath, markdown } = writeMemoryReviewProposal(BOT, report);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain(join(BOT, "memory-review", "2026-11-19.md"));
    expect(readFileSync(join(WORKSPACES_DIR, BOT, "MEMORY.md"), "utf8")).toBe(bigMemory);
    expect(markdown).toContain("memory/huge.md");

    // Proposal files live outside memory/ and must never leak into automatic recall.
    expect(
      buildRecall({ botId: BOT, message: "Memory Review Proposals oversized-topic stale-topic", threadIds: [], label: () => "", author: () => "" }),
    ).toBeNull();
  });

  it("normalizes volatile ids and numbers and ignores non-activity rows", () => {
    expect(normalizeErrorSignature("Request deadbeef1234 failed on port 8799\nsecond line")).toBe(
      "Request <id> failed on port <n>",
    );
    expect(findRepeatedToolFailures([])).toEqual([]);
  });
});
