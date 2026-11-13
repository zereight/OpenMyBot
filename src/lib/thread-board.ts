import { isSnoozed } from "../../shared/wire";
import type { Bot, Task } from "@/state/store";

export const BOARD_COLUMNS = ["attention", "working", "teammates", "idle", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** A closed or archived thread stays in the Done column this long. */
export const BOARD_DONE_WINDOW_MS = 86_400_000;

export interface BoardCard {
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  /** Epoch ms of the newest activity; 0 when unknown. */
  at: number;
  /** The engine stopped or went silent while the thread was meant to be working. */
  stalled: boolean;
  unread: boolean;
  archived: boolean;
  /** A running or queued turn: archiving or deleting the thread now would cut it off. A stalled thread is not locked, so it can still be cleared. */
  locked: boolean;
}

export type ThreadBoard = Record<BoardColumn, BoardCard[]>;

type Queued = Record<string, readonly unknown[] | undefined>;

const recency = (task: Pick<Task, "updatedAt" | "createdAt">): number => task.updatedAt ?? task.createdAt ?? 0;

/** The bot's threads; a bot that has not reported a thread list yet has just its current one. */
function threadsOf(bot: Bot): Task[] {
  return bot.tasks ?? [{ threadId: bot.threadId, title: "", createdAt: 0 }];
}

/** A thread's own flags win; the bot's current thread falls back to the bot-level flags it may be the only one to carry. */
function stateOf(bot: Bot, task: Task) {
  const current = task.threadId === bot.threadId;
  const activity = task.activity ?? (current ? bot.activity : undefined);
  return {
    activity,
    busy: task.busy ?? (current ? bot.busy === true : activity === "working"),
    teammates: task.waitingForTeammates ?? (current && bot.waitingForTeammates === true),
  };
}

/**
 * Places every open thread in one column, derived from the same flags the sidebar reads. The order of the checks is the
 * meaning of the board: a closed thread that is waiting on the person again is "attention", not "done".
 */
export function buildThreadBoard(bots: readonly Bot[], now: number, queued: Queued = {}): ThreadBoard {
  const board: ThreadBoard = { attention: [], working: [], teammates: [], idle: [], done: [] };
  for (const bot of bots) {
    if (bot.hidden) continue;
    for (const task of threadsOf(bot)) {
      const { activity, busy, teammates } = stateOf(bot, task);
      const stalled = activity === "dead" || activity === "no-signal";
      const hasQueued = (queued[task.threadId]?.length ?? 0) > 0;
      const working = busy || activity === "working" || activity === "parked.computer" || hasQueued || stalled;
      const archived = task.archivedAt !== undefined;
      let column: BoardColumn | null;
      if (activity === "waiting-on-you" || (task.openAsks ?? 0) > 0) column = "attention";
      else if (working) column = "working";
      // A routine run is a thread only while it runs.
      else if (task.routineRunId) column = null;
      else if (teammates && !archived) column = "teammates";
      else if (archived || task.closedBy) {
        const endedAt = archived ? task.archivedAt! : task.closedBy!.at;
        column = now - endedAt <= BOARD_DONE_WINDOW_MS ? "done" : null;
      } else column = isSnoozed(task, now) ? null : "idle";
      if (!column) continue;
      board[column].push({
        botId: bot.id, botName: bot.name, threadId: task.threadId, title: task.title,
        at: recency(task), stalled, unread: task.unread === true,
        archived, locked: busy || activity === "working" || hasQueued,
      });
    }
  }
  for (const column of BOARD_COLUMNS) board[column].sort((a, b) => b.at - a.at);
  return board;
}
