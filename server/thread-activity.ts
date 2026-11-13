/** Thread recency stamps and bringing an auto-archived thread back. The store keeps the records; this only moves their clocks. */
import { writeFileAtomic } from "./atomic.ts";
import * as mdb from "./message-db.ts";
import { movesThreadToTop } from "../shared/thread-order.ts";

interface ThreadActivity {
  bots: Array<{ id: string; tasks?: Array<{ threadId: string; createdAt: number; updatedAt?: number; lastThreadOrderAt?: number; askedAt?: number; routineRunId?: string; archivedAt?: number; archivedBy?: "auto" }> }>;
  groups: Array<{ tasks?: Array<{ threadId: string; createdAt: number; updatedAt?: number; lastThreadOrderAt?: number }> }>;
  taskByThread(botId: string, threadId: string): { archivedBy?: "auto" } | undefined;
  patchTask(botId: string, threadId: string, patch: { archivedAt?: number; archivedBy?: "auto"; restoredAt?: number }): unknown;
  saveBots(): void;
  saveGroups(): void;
}

/** In memory only: message writes must not rewrite bots.json. */
export function noteThreadActivity(host: ThreadActivity, threadId: string, at: number, forOrder = false, orderAt = at): void {
  if (!Number.isFinite(at)) return;
  for (const task of [...host.bots, ...host.groups].map((owner) => owner.tasks?.find((candidate) => candidate.threadId === threadId))) {
    if (!task) continue;
    task.updatedAt = Math.max(task.updatedAt ?? 0, at);
    if (forOrder) task.lastThreadOrderAt = Math.max(task.lastThreadOrderAt ?? 0, orderAt);
  }
}

export function noteImportedActivity(host: ThreadActivity, threadId: string, messages: ReadonlyArray<{ at: number; turnCompletedAt?: number } & Parameters<typeof movesThreadToTop>[0]>): void {
  const newest = messages.reduce((max, message) => Math.max(max, message.at), Number.NEGATIVE_INFINITY);
  const newestOrder = messages.reduce((max, message) => movesThreadToTop(message) ? Math.max(max, message.turnCompletedAt ?? message.at) : max, Number.NEGATIVE_INFINITY);
  if (Number.isFinite(newest)) noteThreadActivity(host, threadId, newest, Number.isFinite(newestOrder), newestOrder);
}

/** A failed save leaves the thread archived; the next message tries again, and the message itself is already stored. */
export function restoreAutoArchivedThread(host: ThreadActivity, threadId: string): void {
  const owner = host.bots.find((bot) => bot.tasks?.some((task) => task.threadId === threadId && task.archivedBy === "auto"));
  if (owner) restoreAutoArchived(host, owner.id, threadId);
}

/** A person writing in a thread brings it back, however it was archived: they would not keep talking in a thread they had put away. */
export function restoreArchivedForPerson(host: ThreadActivity, threadId: string): void {
  const owner = host.bots.find((bot) => bot.tasks?.some((task) => task.threadId === threadId && task.archivedAt !== undefined));
  if (!owner) return;
  try {
    host.patchTask(owner.id, threadId, { archivedAt: undefined, archivedBy: undefined, restoredAt: Date.now() });
  } catch (error) {
    console.warn(`bringing an archived thread back failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function restoreAutoArchived(host: ThreadActivity, botId: string, threadId: string): void {
  if (host.taskByThread(botId, threadId)?.archivedBy !== "auto") return;
  try {
    host.patchTask(botId, threadId, { archivedAt: undefined, archivedBy: undefined });
  } catch (error) {
    console.warn(`bringing an auto-archived thread back failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Never moves a stamp backwards: a clock skew must not reshuffle the list on every boot. */
export function repairThreadUpdatedAts(host: ThreadActivity): void {
  const botTasks = host.bots.flatMap((bot) => bot.tasks ?? []);
  const groupTasks = host.groups.flatMap((group) => group.tasks ?? []);
  const latest = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId));
  const latestOrder = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId), true);
  let botsDirty = false;
  let groupsDirty = false;
  const repair = (task: { threadId: string; createdAt: number; updatedAt?: number; lastThreadOrderAt?: number }) => {
    const fromMessages = latest.get(task.threadId);
    const next = fromMessages !== undefined && (task.updatedAt === undefined || fromMessages > task.updatedAt)
      ? fromMessages
      : task.updatedAt ?? task.createdAt;
    const fromOrder = latestOrder.get(task.threadId);
    const orderAt = fromOrder === undefined ? task.lastThreadOrderAt : Math.max(task.lastThreadOrderAt ?? task.createdAt, fromOrder);
    const changed = task.updatedAt !== next || task.lastThreadOrderAt !== orderAt;
    task.updatedAt = next;
    task.lastThreadOrderAt = orderAt;
    return changed;
  };
  for (const task of botTasks) if (repair(task)) botsDirty = true;
  for (const task of groupTasks) if (repair(task)) groupsDirty = true;
  if (botsDirty) host.saveBots();
  if (groupsDirty) host.saveGroups();
}

export function fillTaskAskedAts(host: ThreadActivity, filledMarker: string): void {
  const tasks = host.bots.flatMap((bot) => bot.tasks ?? []).filter((task) => task.askedAt === undefined && !task.routineRunId);
  const asked = mdb.latestPersonLineAts(tasks.map((task) => task.threadId));
  for (const task of tasks) {
    const at = asked.get(task.threadId);
    if (at !== undefined) task.askedAt = at;
  }
  if (asked.size) host.saveBots();
  writeFileAtomic(filledMarker, "Threads from before askedAt have it from the lines people wrote there.\n", { mode: 0o600 });
}
