import { describe, expect, it } from "vitest";
import { COLD_THREAD_TAIL, HELD_AFTER_LEAVING, HELD_FOR_PLACE, MAX_WARM_THREADS, trimmedHeld } from "./message-history";
import { initialState, reducer, type AppState, type Bot, type Group, type Message } from "./store";
import { followHeldTails } from "./held-tails";

const message = (index: number) => ({ id: `m${index}`, at: index, role: "user", kind: "text", text: `m${index}` }) as never as Message;
const thread = (count: number) => Array.from({ length: count }, (_, index) => message(index));
const ids = (owner: { messages: Message[] }) => owner.messages.map((row) => row.id);

const bot = (fields: Partial<Bot> = {}) => ({ id: "bot-1", threadId: "thread-1", messages: thread(3_000), hasMore: false, ...fields }) as never as Bot;
const other = { id: "bot-2", threadId: "thread-2", messages: thread(10), hasMore: false } as never as Bot;
const away = (owner: Bot) => ({ ...initialState, bots: [owner, other], selectedId: other.id, activeView: "chat" as const });

describe("letting go of paged rows when a conversation is left", () => {
  it("keeps the newest rows of a conversation the reader left and lets it page again", () => {
    const left = reducer(away(bot()), { type: "trimHeldMessages", threadId: "thread-1" });
    const trimmed = left.bots[0]!;
    expect(trimmed.messages).toHaveLength(HELD_AFTER_LEAVING);
    expect(ids(trimmed).at(-1)).toBe("m2999");
    expect(trimmed.hasMore).toBe(true);
    expect(left.bots[1]).toBe(other);
  });

  it("keeps the reader's place when it lies close enough to the end", () => {
    const near = 3_000 - HELD_FOR_PLACE;
    expect(ids(trimmedHeld(bot(), `m${near}`))[0]).toBe(`m${near}`);
    expect(trimmedHeld(bot(), `m${near - 1}`).messages).toHaveLength(HELD_AFTER_LEAVING);
  });

  it("never cuts off the pinned message or the leaf of the branch shown", () => {
    expect(ids(trimmedHeld(bot({ pinnedMessageId: "m2500" })))[0]).toBe("m2500");
    expect(trimmedHeld(bot({ pinnedMessageId: "m10" })).messages).toHaveLength(3_000);
    expect(trimmedHeld(bot({ activeLeafId: "m100" })).messages).toHaveLength(3_000);
  });

  it("leaves the conversation on screen and a short one untouched", () => {
    const shown = { ...initialState, bots: [bot()], selectedId: "bot-1", activeView: "chat" as const };
    expect(reducer(shown, { type: "trimHeldMessages", threadId: "thread-1" })).toBe(shown);
    const short = away(bot({ messages: thread(HELD_AFTER_LEAVING) }));
    expect(reducer(short, { type: "trimHeldMessages", threadId: "thread-1" })).toBe(short);
  });

  it("trims a room the reader left the same way", () => {
    const room = { id: "room-1", threadId: "room-thread", messages: thread(900), hasMore: false } as never as Group;
    const left = reducer({ ...initialState, groups: [room], bots: [other], selectedId: other.id }, { type: "trimHeldMessages", threadId: "room-thread" });
    expect(left.groups[0]!.messages).toHaveLength(HELD_AFTER_LEAVING);
    expect(left.groups[0]!.hasMore).toBe(true);
  });

  it("drops an older page asked for before rows that were let go since, so no gap opens", () => {
    const left = reducer(away(bot()), { type: "trimHeldMessages", threadId: "thread-1" });
    const stale = reducer(left, { type: "olderMessages", threadId: "thread-1", generation: 0, before: "m0", messages: [message(-1)], hasMore: false });
    expect(ids(stale.bots[0]!)).toEqual(ids(left.bots[0]!));
    const fresh = reducer(left, { type: "olderMessages", threadId: "thread-1", generation: 0, before: "m2800", messages: thread(2_800).slice(-200), hasMore: true });
    expect(ids(fresh.bots[0]!)[0]).toBe("m2600");
    expect(fresh.bots[0]!.messages).toHaveLength(400);
  });

  it("evicts cold threads past MAX_WARM_THREADS down to COLD_THREAD_TAIL and rehydrates on reopen", async () => {
    const total = MAX_WARM_THREADS + 3;
    const bots = Array.from({ length: total }, (_, index) =>
      bot({ id: `bot-${index}`, threadId: `thread-${index}`, messages: thread(index === 0 ? HELD_AFTER_LEAVING : COLD_THREAD_TAIL), hasMore: true }),
    );
    let state: AppState = { ...initialState, bots, selectedId: "bot-0", activeView: "chat" };
    for (let index = 0; index < total - 1; index++) {
      const nextId = `bot-${index + 1}`;
      state = {
        ...state,
        selectedId: nextId,
        bots: state.bots.map((entry) => entry.id === nextId ? { ...entry, messages: thread(HELD_AFTER_LEAVING) } : entry),
      };
      state = reducer(state, { type: "trimHeldMessages", threadId: `thread-${index}` });
    }
    const warmCounts = state.bots.map((entry) => entry.messages.length);
    expect(warmCounts.filter((count) => count === COLD_THREAD_TAIL)).toHaveLength(total - MAX_WARM_THREADS);
    expect(warmCounts.filter((count) => count === HELD_AFTER_LEAVING)).toHaveLength(MAX_WARM_THREADS);
    expect(state.bots[0]!.messages).toHaveLength(COLD_THREAD_TAIL);
    expect(state.bots[0]!.hasMore).toBe(true);

    const dispatched: Array<{ type: string; threadId?: string }> = [];
    let current = state;
    const listeners = new Set<() => void>();
    const stop = followHeldTails(
      { getState: () => current, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
      (action) => dispatched.push(action as { type: string; threadId?: string }),
    );
    current = { ...current, selectedId: "bot-0" };
    for (const listener of listeners) listener();
    await Promise.resolve();
    stop();
    expect(dispatched).toContainEqual({ type: "loadOlderMessages", threadId: "thread-0" });
  });

  it("does not buffer backgroundThreadEvents for idle background tasks", () => {
    const active = bot({
      id: "bot-1",
      threadId: "thread-active",
      messages: thread(5),
      tasks: [
        { threadId: "thread-active", title: "Active", createdAt: 1 },
        { threadId: "thread-idle-bg", title: "Idle BG", createdAt: 2 },
      ],
    });
    const start: AppState = { ...initialState, bots: [active], selectedId: active.id, activeView: "chat" };
    const next = reducer(start, {
      type: "messageAdded",
      threadId: "thread-idle-bg",
      message: { id: "bg-1", role: "bot", kind: "text", text: "Background output", at: 100 } as never as Message,
    });
    expect(next.backgroundThreadEvents["thread-idle-bg"]).toBeUndefined();
    expect(next.bots[0]!.tasks?.find((task) => task.threadId === "thread-idle-bg")?.updatedAt).toBe(100);
  });
});
