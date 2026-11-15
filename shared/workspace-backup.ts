/** "essentials" keeps bots, instructions, memory, skills, settings, conversations and attachments, and leaves out turn
 * checkpoints, conversation work folders, run logs and project files in bot work folders. "full" (the default when a
 * summary has no scope) carries the whole data folder. */
export type WorkspaceBackupScope = "essentials" | "full";

/** Full, encrypted workspace snapshots are distinct from additive team copies. */
export interface WorkspaceBackupSummary {
  format: "openmaus.workspace-backup";
  version: 1;
  id: string;
  createdAt: string;
  appVersion: string;
  files: number;
  directories: number;
  bytes: number;
  bots: number;
  groups: number;
  threads: number;
  messages: number;
  /** Written only by essentials backups; an older app refuses the unknown key instead of restoring it as a full one. */
  scope?: WorkspaceBackupScope;
  exclusions: string[];
  warnings: string[];
}

/** What a restore from another kind of computer (Windows to Linux, say) could not bring: folders and files outside
 * that computer's data folder. */
export interface WorkspaceLeftBehind {
  /** Bots whose working folder stayed there; they now start in their own folder. */
  bots: number;
  /** Up to 20 of those folders and of the files their instructions name, as written there. */
  paths: string[];
}

export type WorkspaceBackupClientState = Record<string, string>;

export interface WorkspaceBackupPrivateMetadata {
  summary: WorkspaceBackupSummary;
  clientState: WorkspaceBackupClientState;
}
