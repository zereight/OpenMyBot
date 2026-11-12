// Decides which idle threads the daily sweep may archive, and starts it. The sweep itself lives in thread-auto-archive.ts.
import { threadAutoArchiveDays } from "../config.ts";
import { startAutoArchive, toAutoArchiveThread, notHeld, type AutoArchiveHeld, type AutoArchiveThread } from "../thread-auto-archive.ts";

export interface AutoArchiveHostDeps {
  cloud: () => boolean;
  days: () => number | null;
  bots: () => Iterable<{ id: string; tasks?: Parameters<typeof toAutoArchiveThread>[1][] }>;
  tasks: (botId: string) => Parameters<typeof toAutoArchiveThread>[1][];
  busy: (botId: string, threadId: string) => boolean;
  waitingOnYou: (threadId: string) => boolean;
  queued: (botId: string, threadId: string) => boolean;
  parked: (threadId: string) => boolean;
  awaitingTeammate: (threadId: string) => boolean;
  openDirectHandoff: (threadId: string) => boolean;
  openPersonCard: (threadId: string) => boolean;
  hasWait: (botId: string, threadId: string) => boolean;
  routineRun: (threadId: string) => boolean;
  routineResults: (threadId: string) => boolean;
  mainThread: (botId: string) => string | undefined;
  archive: (botId: string, threadId: string, now: number) => void;
}

function held(deps: AutoArchiveHostDeps, botId: string, threadId: string): AutoArchiveHeld {
  return {
    ...notHeld,
    busy: deps.busy(botId, threadId),
    waitingOnYou: deps.waitingOnYou(threadId),
    queued: deps.queued(botId, threadId),
    parked: deps.parked(threadId),
    awaitingTeammate: deps.awaitingTeammate(threadId),
    openDirectHandoff: deps.openDirectHandoff(threadId),
    openPersonCard: deps.openPersonCard(threadId),
    hasWait: deps.hasWait(botId, threadId),
    routineRun: deps.routineRun(threadId),
    routineResults: deps.routineResults(threadId),
    mainThread: deps.mainThread(botId) === threadId,
  };
}

export function startThreadAutoArchive(deps: AutoArchiveHostDeps): void {
  startAutoArchive({
    days: () => deps.cloud() ? null : deps.days(),
    threads: () => [...deps.bots()].flatMap((bot) => deps.tasks(bot.id).map((task) => toAutoArchiveThread(bot, task))),
    held: (thread: AutoArchiveThread) => held(deps, thread.botId, thread.threadId),
    archive: deps.archive,
  });
}

/** What settings shows: on unless switched off, and the number of days actually used. */
export function autoArchiveStatus(cfg: Parameters<typeof threadAutoArchiveDays>[0]): { autoArchive: boolean; autoArchiveDays: number } {
  const days = threadAutoArchiveDays(cfg);
  return { autoArchive: days !== null, autoArchiveDays: days ?? 5 };
}
