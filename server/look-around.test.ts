import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostTurnResult } from "./coordinator.ts";
import { buildLookAroundPrompt, createLookAround, parseLookAroundSuggestions } from "./look-around.ts";
import { createReadAndDraft, READ_AND_DRAFT_REFUSAL } from "./read-and-draft.ts";
import type { Message } from "./store.ts";
import { createSuggestionsStore } from "./suggestions.ts";

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-look-around-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const call = (slug: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: slug, arguments: args }] } },
});

describe("parseLookAroundSuggestions", () => {
  it("parses fenced JSON arrays and enforces the per-turn cap", () => {
    const raw = [
      "Here is what I found:",
      "```json",
      JSON.stringify([
        { title: "One", summary: "s1", prompt: "p1", link: "https://example.com/1" },
        { title: "Two", summary: "s2", prompt: "p2" },
        { title: "Three", summary: "s3", prompt: "p3" },
        { title: "Four", summary: "s4", prompt: "p4" },
        { title: "Five", summary: "s5", prompt: "p5" },
        { title: "Six (over cap)", summary: "s6", prompt: "p6" },
      ]),
      "```",
    ].join("\n");

    const parsed = parseLookAroundSuggestions(raw);
    expect(parsed).toHaveLength(5);
    expect(parsed.map((item) => item.title)).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });
});

describe("createLookAround + read-and-draft guard reuse", () => {
  it("confines the look-around thread through createReadAndDraft (read-only, no drafts, no cards)", async () => {
    const dir = makeDir();
    const suggestions = createSuggestionsStore({ dataDir: dir });
    let settledCb: ((outcome: HostTurnResult) => void) | undefined;
    let capturedPrompt = "";
    const messages: Message[] = [];

    const lookAround = createLookAround({
      suggestions,
      bot: (id) => (id === "chief" ? { id: "chief", name: "Chief" } : undefined),
      createThread: () => "look-thread-1",
      activePath: () => messages,
      startTurn: async (_botId, prompt, opts) => {
        capturedPrompt = prompt;
        settledCb = opts.onSettled;
      },
      now: () => 5_000,
    });

    const decided: unknown[] = [];
    const respond = vi.fn(async () => "rejected" as const);
    const fence = createReadAndDraft({
      runFor: () => null,
      lookAround: lookAround.confines,
      adapter: () => ({ respondToRequest: respond, interruptTurn: vi.fn(async () => {}) }) as never,
      stale: () => false,
      decide: (row) => decided.push(row),
      release: () => {},
      mayDraft: () => true,
      drafted: () => {},
    });
    const bot = { id: "chief", name: "Chief", modelSelection: { instanceId: "claude" } };

    const started = await lookAround.start("chief");
    expect(started).toEqual({ ok: true, threadId: "look-thread-1", startedAt: 5_000 });
    expect(lookAround.status().running).toBe(true);
    expect(await lookAround.start("chief")).toMatchObject({ ok: false, reason: "already_running" });

    // Reused read-and-draft guard enforces all allow-only invariants on the look-around thread:
    expect(fence.confines("look-thread-1")).toBe(true);
    expect(fence.confines("normal-thread")).toBe(false);
    expect(fence.refusesRoute(bot, "look-thread-1", "GET", "/api/internal/session-search")).toBe(false);
    expect(fence.refusesRoute(bot, "look-thread-1", "POST", "/api/internal/memory")).toBe(true);
    expect(fence.refusesConnectorCall(bot, "look-thread-1", call("GMAIL_FETCH_EMAILS"))).toBe(false);
    expect(fence.refusesConnectorCall(bot, "look-thread-1", call("GMAIL_SEND_EMAIL"))).toBe(true);
    // Unlike read-and-draft routines, look-around is strictly read-only and refuses drafts too:
    expect(fence.refusesConnectorCall(bot, "look-thread-1", call("GMAIL_CREATE_EMAIL_DRAFT", { thread_id: "t-1", recipient_email: "a@x.test" }))).toBe(true);

    const say = vi.fn();
    const reqEvent = { type: "request.opened", threadId: "look-thread-1", requestId: "r1", requestType: "permission", tool: "Bash", summary: "rm -rf" } as never;
    expect(fence.answers(reqEvent, bot, say)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith("look-thread-1", "r1", { behavior: "deny", message: READ_AND_DRAFT_REFUSAL }));

    // Settle the turn with 2 suggestions:
    messages.push({
      id: "m1",
      role: "bot",
      kind: "text",
      at: 5_100,
      text: "```json\n" + JSON.stringify([
        { title: "Review PR #57", summary: "CI passed and awaits review.", prompt: "Review PR #57", link: "https://github.com/org/repo/pull/57" },
        { title: "Reply to Ada", summary: "Asked about Friday demo.", prompt: "Draft a reply to Ada" },
      ]) + "\n```",
    });
    settledCb?.({ ok: true } as HostTurnResult);

    expect(lookAround.status().running).toBe(false);
    expect(lookAround.status().lastCount).toBe(2);
    expect(suggestions.list({ botId: "chief" })).toHaveLength(2);
    // Thread remains confined even after finishing:
    expect(fence.confines("look-thread-1")).toBe(true);
    expect(capturedPrompt).toContain("Do not send messages, create drafts");

    // Second run includes fenced previous history (title/status/link only):
    const nextHistory = suggestions.historyRecords("chief");
    const nextPrompt = buildLookAroundPrompt({ botName: "Chief", historyBlock: nextHistory });
    expect(nextPrompt).toContain("[Records from previous look-around suggestions.");
    expect(nextPrompt).toContain("title=Review PR #57");
    expect(nextPrompt).toContain("link=https://github.com/org/repo/pull/57");
    expect(nextPrompt).not.toContain("CI passed and awaits review.");
  });
});
