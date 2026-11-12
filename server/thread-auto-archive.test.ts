import { describe, expect, it } from "vitest";
import { autoArchiveDue, notHeld, sweepAutoArchive, type AutoArchiveHeld, type AutoArchiveThread } from "./thread-auto-archive.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function thread(over: Partial<AutoArchiveThread> = {}): AutoArchiveThread {
  return { botId: "b", threadId: "t", lastActivityAt: NOW - 6 * DAY, ...over };
}

const heldFor = (reason: keyof AutoArchiveHeld): AutoArchiveHeld => ({ ...notHeld, [reason]: true });

describe("autoArchiveDue", () => {
  it("archives a thread idle for more than the window", () => {
    expect(autoArchiveDue(thread(), notHeld, 5, NOW)).toBe(true);
  });

  it("archives a thread idle for exactly the window", () => {
    expect(autoArchiveDue(thread({ lastActivityAt: NOW - 5 * DAY }), notHeld, 5, NOW)).toBe(true);
  });

  it("keeps a thread idle for one millisecond less than the window", () => {
    expect(autoArchiveDue(thread({ lastActivityAt: NOW - 5 * DAY + 1 }), notHeld, 5, NOW)).toBe(false);
  });

  const kept: Array<[string, Partial<AutoArchiveThread>]> = [
    ["already archived", { archivedAt: NOW - DAY }],
    ["pinned", { pinned: true }],
    ["unread", { unread: true }],
    ["a room lane", { roomLane: true }],
    ["a shared chat", { sharedChat: true }],
    ["a bot API thread", { botApi: true }],
    ["an outside thread", { outside: true }],
    ["an open work thread", { openedByKind: "work" }],
    ["an open pair thread", { openedByKind: "pair" }],
    ["snoozed until a time", { snoozedUntil: NOW + DAY }],
    ["snoozed indefinitely", { snoozedUntil: 0 }],
    ["parked at the computer", { activity: "parked.computer" }],
    ["waiting on you", { activity: "waiting-on-you" }],
  ];
  it.each(kept)("keeps a thread that is %s", (_label, over) => {
    expect(autoArchiveDue(thread(over), notHeld, 5, NOW)).toBe(false);
  });

  it("archives a work thread once it has closed", () => {
    expect(autoArchiveDue(thread({ openedByKind: "work", closedAt: NOW - 6 * DAY }), notHeld, 5, NOW)).toBe(true);
  });

  it("archives a thread whose snooze already lapsed", () => {
    expect(autoArchiveDue(thread({ snoozedUntil: NOW - DAY }), notHeld, 5, NOW)).toBe(true);
  });

  const held: Array<keyof AutoArchiveHeld> = [
    "busy", "waitingOnYou", "queued", "parked", "awaitingTeammate", "openDirectHandoff",
    "openPersonCard", "hasWait", "routineRun", "routineResults", "mainThread",
  ];
  it.each(held)("keeps a thread that is held because it is %s", (reason) => {
    expect(autoArchiveDue(thread(), heldFor(reason), 5, NOW)).toBe(false);
  });
});

describe("sweepAutoArchive", () => {
  it("archives only the due threads and reports how many", () => {
    const archived: string[] = [];
    const count = sweepAutoArchive({
      days: () => 5,
      threads: () => [thread({ threadId: "old" }), thread({ threadId: "fresh", lastActivityAt: NOW - DAY })],
      held: () => notHeld,
      archive: (_botId, threadId) => archived.push(threadId),
      now: () => NOW,
      log: () => {},
    });
    expect(archived).toEqual(["old"]);
    expect(count).toBe(1);
  });

  it("does nothing when the setting is off", () => {
    const archived: string[] = [];
    const count = sweepAutoArchive({
      days: () => null,
      threads: () => [thread()],
      held: () => notHeld,
      archive: (_botId, threadId) => archived.push(threadId),
      now: () => NOW,
    });
    expect(count).toBe(0);
    expect(archived).toEqual([]);
  });
});
