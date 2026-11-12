import { describe, expect, it } from "vitest";
import type { Bot, Task } from "@/state/store";
import { BOARD_DONE_WINDOW_MS, buildThreadBoard } from "./thread-board";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const task = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: NOW - 100 * HOUR, updatedAt: NOW - HOUR, ...extra });
const bot = (id: string, tasks: Task[] | undefined, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-main`, name: id, title: "", description: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: { instanceId: "fake", model: "test" }, ...(tasks ? { tasks } : {}), ...extra,
});
const ids = (cards: Array<{ threadId: string }>) => cards.map((card) => card.threadId);

describe("buildThreadBoard", () => {
  it("places each thread in the column its flags describe", () => {
    const board = buildThreadBoard([bot("ada", [
      task("ask", { activity: "waiting-on-you" }),
      task("inbox", { openAsks: 2 }),
      task("busy", { busy: true }),
      task("working", { activity: "working" }),
      task("parked", { activity: "parked.computer" }),
      task("team", { waitingForTeammates: true }),
      task("calm"),
      task("closed", { closedBy: { botId: "x", name: "x", at: NOW - HOUR } }),
      task("shelved", { archivedAt: NOW - HOUR }),
    ])], NOW);
    expect(ids(board.attention).sort()).toEqual(["ask", "inbox"]);
    expect(ids(board.working).sort()).toEqual(["busy", "parked", "working"]);
    expect(ids(board.teammates)).toEqual(["team"]);
    expect(ids(board.idle)).toEqual(["calm"]);
    expect(ids(board.done).sort()).toEqual(["closed", "shelved"]);
  });

  it("keeps a closed thread that needs the person or is running out of Done", () => {
    const closedBy = { botId: "x", name: "x", at: NOW - HOUR };
    const board = buildThreadBoard([bot("ada", [
      task("again", { closedBy, activity: "waiting-on-you" }),
      task("rerun", { archivedAt: NOW - HOUR, busy: true }),
    ])], NOW);
    expect(ids(board.attention)).toEqual(["again"]);
    expect(ids(board.working)).toEqual(["rerun"]);
    expect(board.done).toEqual([]);
  });

  it("lets a running thread win over waiting on teammates", () => {
    const board = buildThreadBoard([bot("ada", [task("both", { busy: true, waitingForTeammates: true })])], NOW);
    expect(ids(board.working)).toEqual(["both"]);
    expect(board.teammates).toEqual([]);
  });

  it("drops what is old, snoozed or a finished routine run", () => {
    const board = buildThreadBoard([bot("ada", [
      task("old-closed", { closedBy: { botId: "x", name: "x", at: NOW - BOARD_DONE_WINDOW_MS - 1 } }),
      task("old-archived", { archivedAt: NOW - BOARD_DONE_WINDOW_MS - 1 }),
      task("until-new", { snoozedUntil: 0 }),
      task("until-later", { snoozedUntil: NOW + HOUR }),
      task("run", { routineRunId: "r1" }),
      task("expired", { snoozedUntil: NOW - HOUR }),
    ])], NOW);
    expect(ids(board.idle)).toEqual(["expired"]);
    expect(board.done).toEqual([]);
  });

  it("shows a routine run only while it runs", () => {
    const board = buildThreadBoard([bot("ada", [task("run", { routineRunId: "r1", busy: true })])], NOW);
    expect(ids(board.working)).toEqual(["run"]);
  });

  it("flags a thread whose engine died as stalled in Working", () => {
    const board = buildThreadBoard([bot("ada", [task("dead", { activity: "dead" }), task("quiet", { activity: "no-signal" }), task("fine", { busy: true })])], NOW);
    expect(board.working.map((card) => [card.threadId, card.stalled]).sort()).toEqual([["dead", true], ["fine", false], ["quiet", true]]);
  });

  it("counts a queued message as work", () => {
    const board = buildThreadBoard([bot("ada", [task("queued"), task("plain")])], NOW, { queued: [{}] });
    expect(ids(board.working)).toEqual(["queued"]);
  });

  it("reads the bot's own flags for its current thread only", () => {
    const tasks = [task("ada-main"), task("other")];
    const board = buildThreadBoard([bot("ada", tasks, { busy: true, activity: "working" })], NOW);
    expect(ids(board.working)).toEqual(["ada-main"]);
    expect(ids(board.idle)).toEqual(["other"]);
  });

  it("gives a bot without a thread list one card for its current thread", () => {
    const board = buildThreadBoard([bot("ada", undefined, { activity: "waiting-on-you" })], NOW);
    expect(board.attention).toMatchObject([{ botId: "ada", threadId: "ada-main" }]);
  });

  it("skips hidden bots and orders cards newest first", () => {
    const board = buildThreadBoard([
      bot("ghost", [task("secret")], { hidden: true }),
      bot("ada", [task("older", { updatedAt: NOW - 5 * HOUR }), task("newer", { updatedAt: NOW - HOUR })]),
    ], NOW);
    expect(ids(board.idle)).toEqual(["newer", "older"]);
  });
});
