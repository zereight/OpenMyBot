// Archives bot threads left idle for the configured number of days. A new message or turn restores one (store.ts), so this only hides a thread nobody is using.
import type { BotRecord, TaskRecord } from "./store.ts";

export const AUTO_ARCHIVE_SWEEP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000;

export interface AutoArchiveThread {
  botId: string;
  threadId: string;
  lastActivityAt: number;
  archivedAt?: number;
  pinned?: boolean;
  unread?: boolean;
  snoozedUntil?: number;
  activity?: string;
  roomLane?: boolean;
  sharedChat?: boolean;
  botApi?: boolean;
  outside?: boolean;
  openedByKind?: "pair" | "work";
  closedAt?: number;
}

/** Reasons a thread must stay where it is, checked by the caller against live state. */
export interface AutoArchiveHeld {
  busy: boolean;
  waitingOnYou: boolean;
  queued: boolean;
  parked: boolean;
  awaitingTeammate: boolean;
  openDirectHandoff: boolean;
  openPersonCard: boolean;
  hasWait: boolean;
  routineRun: boolean;
  routineResults: boolean;
  mainThread: boolean;
}

export const notHeld: AutoArchiveHeld = {
  busy: false, waitingOnYou: false, queued: false, parked: false, awaitingTeammate: false,
  openDirectHandoff: false, openPersonCard: false, hasWait: false, routineRun: false, routineResults: false, mainThread: false,
};

export function toAutoArchiveThread(bot: Pick<BotRecord, "id">, task: TaskRecord): AutoArchiveThread {
  return {
    botId: bot.id,
    threadId: task.threadId,
    lastActivityAt: Math.max(task.updatedAt ?? 0, task.lastThreadOrderAt ?? 0, task.createdAt ?? 0, task.restoredAt ?? 0),
    ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
    ...(task.pinned === true ? { pinned: true } : {}),
    ...(task.unread === true ? { unread: true } : {}),
    ...(task.snoozedUntil !== undefined ? { snoozedUntil: task.snoozedUntil } : {}),
    ...(task.activity !== undefined ? { activity: task.activity } : {}),
    ...(task.openedBy?.roomLane === true ? { roomLane: true } : {}),
    ...(task.sharedChat === true ? { sharedChat: true } : {}),
    ...(task.botApi === true ? { botApi: true } : {}),
    ...(task.outside === true ? { outside: true } : {}),
    ...(task.openedBy?.kind !== undefined ? { openedByKind: task.openedBy.kind } : {}),
    ...(task.closedBy !== undefined ? { closedAt: task.closedBy.at } : {}),
  };
}

export function autoArchiveDue(thread: AutoArchiveThread, held: AutoArchiveHeld, days: number, now: number): boolean {
  if (thread.archivedAt !== undefined || thread.pinned === true || thread.unread === true) return false;
  if (thread.roomLane === true || thread.sharedChat === true || thread.botApi === true || thread.outside === true) return false;
  if (thread.openedByKind !== undefined && thread.closedAt === undefined) return false;
  if (thread.snoozedUntil === 0 || (thread.snoozedUntil !== undefined && thread.snoozedUntil > now)) return false;
  if (thread.activity === "parked.computer" || thread.activity === "waiting-on-you") return false;
  if (Object.values(held).some(Boolean)) return false;
  return thread.lastActivityAt <= now - days * DAY_MS;
}

export interface AutoArchiveDeps {
  days: () => number | null;
  threads: () => Iterable<AutoArchiveThread>;
  held: (thread: AutoArchiveThread) => AutoArchiveHeld;
  archive: (botId: string, threadId: string, now: number) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export function sweepAutoArchive(deps: AutoArchiveDeps): number {
  const days = deps.days();
  if (days === null) return 0;
  const now = (deps.now ?? Date.now)();
  let archived = 0;
  for (const thread of deps.threads()) {
    if (!autoArchiveDue(thread, deps.held(thread), days, now)) continue;
    deps.archive(thread.botId, thread.threadId, now);
    archived++;
  }
  if (archived > 0) (deps.log ?? console.log)(`[auto-archive] archived ${archived} idle thread(s) past ${days} day(s)`);
  return archived;
}

export function startAutoArchive(deps: AutoArchiveDeps): void {
  const run = () => {
    try {
      sweepAutoArchive(deps);
    } catch (error) {
      console.warn(`thread auto-archive sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(run, AUTO_ARCHIVE_SWEEP_MS).unref();
}
