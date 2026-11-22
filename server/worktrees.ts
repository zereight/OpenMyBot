import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
const MIN_SETUP_TIMEOUT_MS = 1_000;
const MAX_SETUP_TIMEOUT_MS = 300_000;
const MAX_SETUP_COMMANDS = 20;
const MAX_ENV_FILES = 50;
const ROOT_ENV_FILE = /^\.env($|\.)/;
const HOOKS_CONFIG_REL = join(".openmybot", "worktree.json");

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

export interface WorktreeHooksConfig {
  copyEnv?: boolean;
  envFiles?: string[];
  setup?: string[];
  timeoutMs?: number;
}

export interface WorktreeSetupReport {
  trusted: boolean;
  copiedEnv: string[];
  commandsRun: number;
  skippedReason?: string;
  warning?: string;
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

export function isTrustedWorktreeRepo(repoRoot: string, trustedRepos?: readonly string[]): boolean {
  if (!trustedRepos?.length) return false;
  let canonicalRepo: string;
  try {
    canonicalRepo = realpathSync(repoRoot);
  } catch {
    return false;
  }
  for (const entry of trustedRepos) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      if (realpathSync(trimmed) === canonicalRepo) return true;
    } catch {
    }
  }
  return false;
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function hasSymlinkAncestor(root: string, relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function readWorktreeHooksConfig(
  repoRoot: string,
): { ok: true; config: WorktreeHooksConfig | null } | { ok: false; error: string } {
  const configPath = join(repoRoot, HOOKS_CONFIG_REL);
  let stat;
  try {
    stat = lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ok: true, config: null };
    return { ok: false, error: `could not stat ${HOOKS_CONFIG_REL}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `${HOOKS_CONFIG_REL} must be a regular file` };
  }
  let realRepo: string;
  let realConfig: string;
  try {
    realRepo = realpathSync(repoRoot);
    realConfig = realpathSync(configPath);
  } catch {
    return { ok: false, error: `could not resolve ${HOOKS_CONFIG_REL}` };
  }
  if (!isInsideRoot(realRepo, realConfig)) {
    return { ok: false, error: `${HOOKS_CONFIG_REL} escapes repository root` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(realConfig, "utf8"));
  } catch {
    return { ok: false, error: `${HOOKS_CONFIG_REL} contains invalid JSON` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${HOOKS_CONFIG_REL} must be a JSON object` };
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(["copyEnv", "envFiles", "setup", "timeoutMs"]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { ok: false, error: `${HOOKS_CONFIG_REL} has unknown field "${key}"` };
  }
  const config: WorktreeHooksConfig = {};
  if (rec.copyEnv !== undefined) {
    if (typeof rec.copyEnv !== "boolean") return { ok: false, error: `${HOOKS_CONFIG_REL} copyEnv must be a boolean` };
    config.copyEnv = rec.copyEnv;
  }
  if (rec.envFiles !== undefined) {
    if (!Array.isArray(rec.envFiles) || rec.envFiles.length > MAX_ENV_FILES) {
      return { ok: false, error: `${HOOKS_CONFIG_REL} envFiles must be an array of up to ${MAX_ENV_FILES} relative paths` };
    }
    const envFiles: string[] = [];
    for (const item of rec.envFiles) {
      if (typeof item !== "string" || !item.trim()) {
        return { ok: false, error: `${HOOKS_CONFIG_REL} envFiles entries must be non-empty strings` };
      }
      envFiles.push(item.trim());
    }
    config.envFiles = envFiles;
  }
  if (rec.setup !== undefined) {
    const list = typeof rec.setup === "string" ? [rec.setup] : Array.isArray(rec.setup) ? rec.setup : null;
    if (!list || list.length > MAX_SETUP_COMMANDS) {
      return { ok: false, error: `${HOOKS_CONFIG_REL} setup must be a command string or array of up to ${MAX_SETUP_COMMANDS} commands` };
    }
    const commands: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !item.trim()) {
        return { ok: false, error: `${HOOKS_CONFIG_REL} setup commands must be non-empty strings` };
      }
      commands.push(item.trim());
    }
    config.setup = commands;
  }
  if (rec.timeoutMs !== undefined) {
    if (
      typeof rec.timeoutMs !== "number"
      || !Number.isInteger(rec.timeoutMs)
      || rec.timeoutMs < MIN_SETUP_TIMEOUT_MS
      || rec.timeoutMs > MAX_SETUP_TIMEOUT_MS
    ) {
      return { ok: false, error: `${HOOKS_CONFIG_REL} timeoutMs must be an integer between ${MIN_SETUP_TIMEOUT_MS} and ${MAX_SETUP_TIMEOUT_MS}` };
    }
    config.timeoutMs = rec.timeoutMs;
  }
  return { ok: true, config };
}

function findRootEnvFiles(repoRoot: string): string[] {
  try {
    return readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ROOT_ENV_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function copyEnvFiles(
  repoRoot: string,
  targetPath: string,
  files: readonly string[],
  explicit: boolean,
): { copied: string[]; warnings: string[] } {
  const copied: string[] = [];
  const warnings: string[] = [];
  let realRepo: string;
  let realTarget: string;
  try {
    realRepo = realpathSync(repoRoot);
    realTarget = realpathSync(targetPath);
  } catch {
    return { copied, warnings: ["could not resolve paths for .env copy"] };
  }

  for (const rel of files) {
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      warnings.push(`skipped unsafe env path "${rel}"`);
      continue;
    }
    const src = resolve(realRepo, rel);
    const dst = resolve(realTarget, rel);
    const normalizedRel = relative(realRepo, src);
    if (!normalizedRel || normalizedRel.startsWith("..") || isAbsolute(normalizedRel) || !isInsideRoot(realTarget, dst)) {
      warnings.push(`skipped unsafe env path "${rel}"`);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(src);
    } catch {
      if (explicit) warnings.push(`env file not found: "${rel}"`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`skipped non-regular env file "${rel}"`);
      continue;
    }
    try {
      if (!isInsideRoot(realRepo, realpathSync(src))) {
        warnings.push(`skipped env file escaping repository "${rel}"`);
        continue;
      }
    } catch {
      warnings.push(`skipped unreadable env file "${rel}"`);
      continue;
    }
    if (hasSymlinkAncestor(realTarget, normalizedRel)) {
      warnings.push(`skipped env file with symlinked target parent "${rel}"`);
      continue;
    }
    if (existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      if (!isInsideRoot(realTarget, realpathSync(dirname(dst)))) {
        warnings.push(`skipped env file with escaping target parent "${rel}"`);
        continue;
      }
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`failed to copy "${rel}": ${reason}`);
    }
  }
  return { copied, warnings };
}

function formatCommandError(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown; killed?: boolean; signal?: string };
    if (err.killed && err.signal) return `timed out (${err.signal})`;
    const detail = typeof err.stderr === "string" && err.stderr.trim()
      ? err.stderr.trim()
      : typeof err.message === "string"
        ? err.message.trim()
        : String(error);
    return detail.length > 300 ? `${detail.slice(0, 300)}...` : detail;
  }
  return String(error);
}

async function runWorktreeSetupCommands(opts: {
  repoRoot: string;
  targetPath: string;
  branch: string;
  base: string;
  commands: readonly string[];
  timeoutMs: number;
}): Promise<{ commandsRun: number; warning?: string }> {
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMB_WORKTREE_PATH: opts.targetPath,
    OMB_WORKTREE_REPO: opts.repoRoot,
    OMB_WORKTREE_BRANCH: opts.branch,
    OMB_WORKTREE_BASE: opts.base,
  };
  let commandsRun = 0;
  for (const command of opts.commands) {
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    try {
      await execFileAsync(shell, args, {
        cwd: opts.targetPath,
        env,
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      commandsRun += 1;
    } catch (error) {
      return {
        commandsRun,
        warning: `worktree setup command failed (${command}): ${formatCommandError(error)}`,
      };
    }
  }
  return { commandsRun };
}

export async function runWorktreeHooks(opts: {
  repoRoot: string;
  targetPath: string;
  branch: string;
  base: string;
  trustedRepos?: readonly string[];
}): Promise<WorktreeSetupReport> {
  const trusted = isTrustedWorktreeRepo(opts.repoRoot, opts.trustedRepos);
  if (!trusted) {
    const hasHookConfig = existsSync(join(opts.repoRoot, HOOKS_CONFIG_REL));
    const hasUncopiedEnv = findRootEnvFiles(opts.repoRoot).some((file) => !existsSync(join(opts.targetPath, file)));
    if (hasHookConfig || hasUncopiedEnv) {
      return {
        trusted: false,
        copiedEnv: [],
        commandsRun: 0,
        skippedReason: "untrusted repository",
        warning: `worktree setup hooks and .env* copy skipped for untrusted repo "${opts.repoRoot}" (add it to worktrees.trustedRepos in config.json to enable)`,
      };
    }
    return { trusted: false, copiedEnv: [], commandsRun: 0 };
  }

  const parsed = readWorktreeHooksConfig(opts.repoRoot);
  if (!parsed.ok) {
    return { trusted: true, copiedEnv: [], commandsRun: 0, warning: parsed.error };
  }
  const config = parsed.config;
  const warnings: string[] = [];
  let copiedEnv: string[] = [];

  if (config?.copyEnv ?? true) {
    const explicit = config?.envFiles !== undefined;
    const candidates = config?.envFiles ?? findRootEnvFiles(opts.repoRoot);
    const envResult = copyEnvFiles(opts.repoRoot, opts.targetPath, candidates, explicit);
    copiedEnv = envResult.copied;
    warnings.push(...envResult.warnings);
  }

  let commandsRun = 0;
  if (config?.setup?.length) {
    const setupResult = await runWorktreeSetupCommands({
      repoRoot: opts.repoRoot,
      targetPath: opts.targetPath,
      branch: opts.branch,
      base: opts.base,
      commands: config.setup,
      timeoutMs: config.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
    });
    commandsRun = setupResult.commandsRun;
    if (setupResult.warning) warnings.push(setupResult.warning);
  }

  const warning = warnings.length > 0 ? warnings.join("; ") : undefined;
  return {
    trusted: true,
    copiedEnv,
    commandsRun,
    ...(warning ? { warning } : {}),
  };
}

export async function createThreadWorktree(opts: {
  botId: string;
  botCwd?: string;
  request: WorktreeRequest;
  id?: string;
  trustedRepos?: readonly string[];
}): Promise<{ ok: true; worktree: ThreadWorktree; setup: WorktreeSetupReport; warning?: string } | { ok: false; error: string }> {
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

  const cloneWarning = await cloneNodeModulesBestEffort(repo.repoRoot, targetPath);
  const setup = await runWorktreeHooks({
    repoRoot: repo.repoRoot,
    targetPath,
    branch,
    base,
    trustedRepos: opts.trustedRepos,
  });
  const warning = [cloneWarning, setup.warning].filter(Boolean).join("; ") || undefined;
  return {
    ok: true,
    worktree: { repo: repo.repoRoot, branch, base, baseCommit, path: targetPath },
    setup,
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
  trustedRepos?: readonly string[],
): Promise<{ ok: true; worktree?: ThreadWorktree; setup?: WorktreeSetupReport; warning?: string } | { ok: false; error: string }> {
  const parsed = parseWorktreeRequest(raw);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: true };
  return createThreadWorktree({ botId, botCwd, request: parsed.value, trustedRepos });
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
