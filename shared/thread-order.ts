/** Fork-only. The ordering functions live in upstream's phone protocol (wire.ts) and are re-exported here untouched, so upstream edits to them merge without a conflict. */
import type { WireTask } from "../packages/phone-protocol/src/wire.ts";

export { isSnoozed, movesThreadToTop, nextOpenThread, orderedThreadList } from "../packages/phone-protocol/src/wire.ts";

/** A person's archive takes a thread out of routing; the server's own (`archivedBy` "auto") does not, since any message to it restores it. */
export const archivedByPerson = (task: Pick<WireTask, "archivedAt" | "archivedBy">): boolean =>
  task.archivedAt !== undefined && task.archivedBy !== "auto";

/** Archived threads sink below the live ones; each group keeps its order (the sort is stable). Pinned or not, an archived thread is last. */
export function archivedLast<T extends Pick<WireTask, "archivedAt">>(tasks: readonly T[]): T[] {
  return [...tasks.filter((task) => task.archivedAt === undefined), ...tasks.filter((task) => task.archivedAt !== undefined)];
}
