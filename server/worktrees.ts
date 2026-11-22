import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const execFileAsync = promisify(execFile);

const SAFE_SEGMENT = /^[\w-]+$/;
const UNSAFE_REF_CHARS = /[\s~^:?*[\]\\]|\.\.|@\{/;

function hasUnsafeRefChars(value: string): boolean {
  if (UNSAFE_REF_CHARS.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const GIT_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 30_000;

export interface WorktreeRequest {
  branch?: string;
  base?: string;
  repo?: string;
}

export interface ThreadWorktree {
  repo: string;
  branch: string;
  base: string;
  baseCommit: string;
  path: string;
}

function worktreesRoot(): string {
  return join(DATA_DIR, "worktrees");
}

function registryFile(): string {
  return join(worktreesRoot(), "registry.json");
}

function readRegistry(): Record<string, ThreadWorktree> {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, ThreadWorktree>) : {};
  } catch {
    return {};
  }
}

function writeRegistry(data: Record<string, ThreadWorktree>): void {
  mkdirSync(worktreesRoot(), { recursive: true, mode: 0o700 });
  writeFileAtomic(registryFile(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function registerThreadWorktree(threadId: string, worktree: ThreadWorktree): void {
  const data = readRegistry();
  data[threadId] = worktree;
  writeRegistry(data);
}

export function getThreadWorktree(threadId: string): ThreadWorktree | undefined {
  return readRegistry()[threadId];
}

export function unregisterThreadWorktree(threadId: string): void {
  const data = readRegistry();
  if (!(threadId in data)) return;
  delete data[threadId];
  writeRegistry(data);
}

export function parseWorktreeRequest(raw: unknown): { ok: true; value: WorktreeRequest | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === false) return { ok: true, value: undefined };
  if (raw === true) return { ok: true, value: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "worktree must be an object with optional branch, base, and repo strings" };
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(["branch", "base", "repo"]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { ok: false, error: `worktree has unknown field "${key}"` };
    if (rec[key] !== undefined && (typeof rec[key] !== "string" || !rec[key].trim())) {
      return { ok: false, error: `worktree.${key} must be a non-empty string` };
    }
  }
  return {
    ok: true,
    value: {
      ...(typeof rec.branch === "string" ? { branch: rec.branch.trim() } : {}),
      ...(typeof rec.base === "string" ? { base: rec.base.trim() } : {}),
      ...(typeof rec.repo === "string" ? { repo: rec.repo.trim() } : {}),
    },
  };
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function gitToplevel(dir: string): Promise<string | null> {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return null;
  }
  try {
    const top = await runGit(["-C", real, "rev-parse", "--show-toplevel"]);
    return top ? realpathSync(top) : null;
  } catch {
    return null;
  }
}

export async function resolveAllowedRepo(
  botCwd: string | undefined,
  requestedRepo?: string,
): Promise<{ ok: true; repoRoot: string } | { ok: false; error: string }> {
  if (!botCwd) {
    return { ok: false, error: "worktree requires this bot to have a working folder inside a Git repository" };
  }
  const allowedRoot = await gitToplevel(botCwd);
  if (!allowedRoot) {
    return { ok: false, error: "this bot's working folder is not inside a Git repository" };
  }
  if (requestedRepo) {
    const requestedRoot = await gitToplevel(requestedRepo);
    if (!requestedRoot || requestedRoot !== allowedRoot) {
      return { ok: false, error: "worktree.repo must be inside this bot's Git repository" };
    }
  }
  return { ok: true, repoRoot: allowedRoot };
}

async function cloneNodeModulesBestEffort(repoRoot: string, targetPath: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const src = join(repoRoot, "node_modules");
  const dst = join(targetPath, "node_modules");
  if (!existsSync(src) || existsSync(dst)) return undefined;
  try {
    await execFileAsync("cp", ["-cR", src, dst], { timeout: CLONE_TIMEOUT_MS });
    return undefined;
  } catch (error) {
    try {
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    } catch {
    }
    const reason = error instanceof Error ? error.message : String(error);
    return `node_modules clone skipped: ${reason}`;
  }
}

export async function createThreadWorktree(opts: {
  botId: string;
  botCwd?: string;
  request: WorktreeRequest;
  id?: string;
}): Promise<{ ok: true; worktree: ThreadWorktree; warning?: string } | { ok: false; error: string }> {
  const id = opts.id ?? randomUUID();
  if (!SAFE_SEGMENT.test(opts.botId) || !SAFE_SEGMENT.test(id)) {
    return { ok: false, error: "invalid bot or worktree identifier" };
  }
  const repo = await resolveAllowedRepo(opts.botCwd, opts.request.repo);
  if (!repo.ok) return repo;

  const base = opts.request.base ?? "HEAD";
  if (!base || base.startsWith("-") || hasUnsafeRefChars(base)) {
    return { ok: false, error: `invalid worktree base ref "${base}"` };
  }
  let baseCommit: string;
  try {
    baseCommit = await runGit(["-C", repo.repoRoot, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  } catch {
    return { ok: false, error: `worktree base "${base}" does not resolve to a commit in this repository` };
  }

  const branch = opts.request.branch ?? `omb/wt-${id.slice(0, 8)}`;
  if (!branch || branch.startsWith("-") || hasUnsafeRefChars(branch)) {
    return { ok: false, error: `invalid worktree branch name "${branch}"` };
  }
  try {
    await runGit(["check-ref-format", "--branch", branch]);
  } catch {
    return { ok: false, error: `invalid Git branch name "${branch}"` };
  }
  try {
    await runGit(["-C", repo.repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return { ok: false, error: `branch "${branch}" already exists` };
  } catch {
  }

  const targetPath = join(worktreesRoot(), opts.botId, id);
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  try {
    await runGit(["-C", repo.repoRoot, "worktree", "add", "-b", branch, "--", targetPath, baseCommit]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not create Git worktree: ${reason}` };
  }

  const warning = await cloneNodeModulesBestEffort(repo.repoRoot, targetPath);
  return {
    ok: true,
    worktree: { repo: repo.repoRoot, branch, base, baseCommit, path: targetPath },
    ...(warning ? { warning } : {}),
  };
}

async function hasUnpushedCommits(worktree: ThreadWorktree): Promise<boolean> {
  try {
    const aheadUpstream = await runGit(["-C", worktree.path, "rev-list", "--count", "@{u}..HEAD"]);
    return Number(aheadUpstream) > 0;
  } catch {
  }
  try {
    const aheadBase = await runGit(["-C", worktree.path, "rev-list", "--count", `${worktree.baseCommit}..HEAD`]);
    return Number(aheadBase) > 0;
  } catch {
    return true;
  }
}

export async function removeThreadWorktree(
  worktree: ThreadWorktree,
  opts: { force?: boolean } = {},
): Promise<{ removed: boolean; reason?: string }> {
  if (!existsSync(worktree.path)) {
    try {
      await runGit(["-C", worktree.repo, "worktree", "prune"]);
    } catch {
    }
    return { removed: true };
  }
  if (!opts.force) {
    try {
      const status = await runGit(["-C", worktree.path, "status", "--porcelain"]);
      if (status.length > 0) return { removed: false, reason: "dirty working tree" };
    } catch {
      return { removed: false, reason: "could not inspect worktree status" };
    }
    if (await hasUnpushedCommits(worktree)) {
      return { removed: false, reason: "unpushed commits" };
    }
  }
  const args = ["-C", worktree.repo, "worktree", "remove", ...(opts.force ? ["--force"] : []), "--", worktree.path];
  try {
    await runGit(args);
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function prepareWorktreeForThread(
  botId: string,
  botCwd: string | undefined,
  raw: unknown,
): Promise<{ ok: true; worktree?: ThreadWorktree; warning?: string } | { ok: false; error: string }> {
  const parsed = parseWorktreeRequest(raw);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: true };
  return createThreadWorktree({ botId, botCwd, request: parsed.value });
}

export async function cleanupDeletedThreadWorktree(threadId: string): Promise<{ removed: boolean; reason?: string } | null> {
  const worktree = getThreadWorktree(threadId);
  if (!worktree) return null;
  const result = await removeThreadWorktree(worktree);
  if (result.removed) {
    unregisterThreadWorktree(threadId);
  } else {
    console.warn(`worktrees: kept ${worktree.path} for deleted thread ${threadId} (${result.reason ?? "not clean"})`);
  }
  return result;
}
