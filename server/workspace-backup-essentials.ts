// An essentials backup carries what a person needs to bring their bots over (instructions, memory, skills, settings,
// conversations, attachments) without what the bots' work regenerates or keeps in its own repositories. Its restore
// keeps those in place: whole roots stay, and bot folders stay while only the children the backup carries are swapped.
import { lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import { validRelative } from "./workspace-backup-paths.ts";

/** Top-level roots an essentials backup leaves out and its restore never moves. */
const KEPT_ROOTS = new Set(["checkpoints", "task-workspaces", "events", "native", "tool-results", "browser-uploads"]);
/** Swapped per bot, never as a whole: a restore keeps the project clones in bot work folders and each bot's Data tables. */
const NESTED_ROOTS: readonly string[] = ["bots", "workspaces"];
// Not `.claude/settings.json`: its hooks name absolute script paths that are not carried, and a missing hook script
// blocks the bot's tools on the new computer.
const WORKSPACE_CHILDREN = new Set(["MEMORY.md", "memory", "skills"]);

export interface NestedJournal {
  /** `bots/<id>/<child>` and `workspaces/<id>/<child>` swapped one by one inside folders that stay. */
  nested?: string[];
  nestedExisting?: string[];
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function realFolder(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

export function essentialsExclusionNotes(fullNotes: readonly string[]): string[] {
  return [
    // The full note says durable workspace files are included, which essentials does not do.
    ...fullNotes.map((note) => note.startsWith("VM/container disk layers") ? "VM/container disk layers and remote cloud data." : note),
    "Essentials backup: each bot's work folder keeps only its memory (MEMORY.md and memory/) and skills; project clones, scripts, bot tool settings (.claude) and other work files are left out.",
    "Turn checkpoints, conversation work folders, run logs, tool results and browser uploads are left out. Restoring on this computer keeps the ones already here, along with each bot's work files and Data tab tables; on a new computer they start empty.",
    "Chat attachments are included; a file a conversation only names by its path may not open on a new computer.",
  ];
}

/** A data-folder top-level name an essentials restore never moves as a whole (folded: macOS and Windows match case). */
export function essentialsKeptInPlace(name: string): boolean {
  const folded = name.toLowerCase();
  return KEPT_ROOTS.has(folded) || NESTED_ROOTS.includes(folded);
}
/** Whether an essentials export walks into this path; ownership folders are checked by type with essentialArchivePath. */
export function essentialExportPath(path: string): boolean {
  const parts = path.split("/");
  if (KEPT_ROOTS.has(parts[0].toLowerCase())) return false;
  return parts[0] !== "workspaces" || parts.length < 3 || WORKSPACE_CHILDREN.has(parts[2]);
}
/** Essentials archives may hold nothing a restore keeps in place, so a crafted one cannot replace what it leaves behind. */
export function essentialArchivePath(path: string, type: string): boolean {
  const parts = path.split("/");
  const folded = parts[0].toLowerCase();
  if (KEPT_ROOTS.has(folded)) return false;
  if (!NESTED_ROOTS.includes(folded)) return true;
  if (parts[0] !== folded) return false;
  if (parts.length <= 2) return type === "directory";
  return folded !== "workspaces" || WORKSPACE_CHILDREN.has(parts[2]);
}
function nestedRestorePath(path: unknown): path is string {
  if (typeof path !== "string" || !validRelative(path)) return false;
  const parts = path.split("/");
  return parts.length === 3 && NESTED_ROOTS.includes(parts[0]) && (parts[0] !== "workspaces" || WORKSPACE_CHILDREN.has(parts[2]));
}

/** A recovery journal's per-bot paths: each a carried child, none twice, and every original one also swapped. */
export function validNestedJournal(raw: Record<string, unknown>): boolean {
  for (const key of ["nested", "nestedExisting"] as const) {
    const paths = raw[key];
    if (paths === undefined) continue;
    if (!Array.isArray(paths) || !paths.every(nestedRestorePath) || new Set(paths).size !== paths.length) return false;
  }
  return !Array.isArray(raw.nestedExisting) || raw.nestedExisting.every((path) => Array.isArray(raw.nested) && raw.nested.includes(path));
}

/** What a restore will swap inside bot folders: every child the prepared copy holds, and which of them exist here now. */
export function planNestedSwap(dataDir: string, prepared: string): Required<NestedJournal> {
  const nested: string[] = [];
  const nestedExisting: string[] = [];
  for (const top of NESTED_ROOTS) {
    if (!entryExists(join(prepared, top))) continue;
    if (entryExists(join(dataDir, top)) && !realFolder(join(dataDir, top))) throw new Error("Unsafe workspace restore target.");
    for (const owner of readdirSync(join(prepared, top)).sort()) {
      if (entryExists(join(dataDir, top, owner)) && !realFolder(join(dataDir, top, owner))) throw new Error("Unsafe workspace restore target.");
      for (const child of readdirSync(join(prepared, top, owner)).sort()) {
        const path = `${top}/${owner}/${child}`;
        if (!nestedRestorePath(path)) throw new Error("Unsafe workspace restore target.");
        nested.push(path);
        if (entryExists(join(dataDir, path))) nestedExisting.push(path);
      }
    }
  }
  return { nested, nestedExisting };
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  renameSync(from, to);
}
/** The originals go to the safety copy first, then the backup's children take their places. */
export function swapNested(dataDir: string, prepared: string, saved: string, journal: NestedJournal): void {
  for (const path of journal.nestedExisting ?? []) move(join(dataDir, path), join(saved, path));
  for (const path of journal.nested ?? []) move(join(prepared, path), join(dataDir, path));
}
/** Undoes swapNested at any point; the parent folders never moved, so what stayed beside them is untouched either way. */
export function rollbackNested(dataDir: string, stage: string, saved: string, journal: NestedJournal): void {
  const existing = journal.nestedExisting ?? [];
  for (const path of journal.nested ?? []) {
    const originalMoved = !existing.includes(path) || entryExists(join(saved, path));
    if (originalMoved && !entryExists(join(stage, path)) && entryExists(join(dataDir, path))) move(join(dataDir, path), join(stage, path));
  }
  for (const path of existing) {
    if (!entryExists(join(saved, path))) continue;
    if (entryExists(join(dataDir, path))) throw new Error("Restore rollback found conflicting files. Both copies are preserved for recovery.");
    move(join(saved, path), join(dataDir, path));
  }
}
