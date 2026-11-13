// `doctor --claude`: what this machine's bots take into a Claude Code turn from files a person or a bot can edit. It only
// reads, and prints paths, key names and counts: never a hook command, an env value or a rule's text.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { botSettingsFor } from "../drivers/claude-bot-settings.ts";
import { EXIT, flag, usageError } from "./args.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import type { HostCheck } from "./host-doctor.ts";

export interface ClaudeOptions {
  dataDir: string;
  home: string;
}

type Settings = Record<string, unknown>;

const MAX_BYTES = 1024 * 1024;
const SETTINGS_KEYS = ["hooks", "permissions", "env", "enabledPlugins", "extraKnownMarketplaces"] as const;
const RULE_LISTS = ["allow", "ask", "deny", "additionalDirectories"] as const;
const ANY_SHELL = /^(?:\*|Bash(?:\(\s*(?:\*|:\*|\*:\*)?\s*\))?)$/;

const ok = (id: string, message: string): HostCheck => ({ id, status: "ok", message });
const warn = (id: string, message: string, fix?: string): HostCheck => ({ id, status: "warn", message, ...(fix ? { fix } : {}) });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const isObject = (value: unknown): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function skillsCheck({ dataDir, home }: ClaudeOptions): HostCheck {
  const config = readJson(join(dataDir, "config.json"));
  const features = isObject(config) && isObject(config.features) ? config.features : {};
  if (features.claudeUserSkills !== true) return ok("claude-skills", "Your Claude Code skills (~/.claude/skills) are not shared with bots");
  const source = join(home, ".claude", "skills");
  let entries: string[];
  try {
    if (!statSync(source).isDirectory()) throw new Error("not a folder");
    entries = readdirSync(source).filter((name) => !name.startsWith("."));
  } catch {
    return warn("claude-skills", `Skills are shared with bots, but ${source} is not a folder, so they get none`, "make the folder, or turn the sharing off in Settings");
  }
  const unusable = entries.filter((name) => {
    try {
      return !statSync(join(source, name, "SKILL.md")).isFile();
    } catch {
      return true;
    }
  });
  if (unusable.length) {
    return warn("claude-skills", `Bots load the skills in ${source}, but ${unusable.length} of ${entries.length} have no SKILL.md: ${unusable.join(", ")}`, "add its SKILL.md, or move the folder out");
  }
  return ok("claude-skills", `Bots load the ${plural(entries.length, "skill")} in ${source}, scripts included`);
}

/** Entries under a key; a value of the wrong type counts as one entry, so a turn that drops it shows as a loss. */
const sizeOf = (settings: Settings, key: (typeof SETTINGS_KEYS)[number]): number => {
  const value = settings[key];
  if (value === undefined) return 0;
  if (!isObject(value)) return 1;
  if (key === "permissions") return RULE_LISTS.reduce((sum, list) => sum + (value[list] === undefined ? 0 : Array.isArray(value[list]) ? value[list].length : 1), 0);
  return Object.keys(value).length;
};

function botCheck(id: string, name: string, file: string): HostCheck | null {
  const label = `Bot "${name}": ${file}`;
  const tag = `claude-bot-${id}`;
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return warn(tag, `${label} is a link, and turns never read through one`, "replace it with a regular file");
  if (!stat.isFile() || stat.size > MAX_BYTES) return warn(tag, `${label} is not a regular file under 1 MB, so turns skip it`, "replace it with a regular JSON file");
  const parsed = readJson(file);
  if (!isObject(parsed)) return warn(tag, `${label} is not a JSON object: Claude Code ignores it`, "fix the JSON");
  // A folder that is the turn's own is read by Claude Code itself; the file is read here for turns that run in another one.
  const carried = botSettingsFor(file, "/", {});
  const issues: string[] = [];
  for (const key of SETTINGS_KEYS) {
    const wrote = sizeOf(parsed, key);
    const took = sizeOf(carried, key);
    if (wrote > took) {
      issues.push(took === 0 ? `\`${key}\` has the wrong shape, so turns in another folder carry none of it` : `\`${key}\`: ${wrote - took} of ${wrote} entries left out for the wrong shape`);
    }
  }
  const permissions = isObject(parsed.permissions) ? parsed.permissions : {};
  if (Array.isArray(permissions.allow) && permissions.allow.some((rule) => typeof rule === "string" && ANY_SHELL.test(rule.trim()))) {
    issues.push("`permissions.allow` lets every shell command run without asking");
  }
  if (issues.length) return warn(tag, `${label}: ${issues.join("; ")}`, "see https://docs.claude.com/en/docs/claude-code/settings");
  const hooks = isObject(carried.hooks) ? Object.keys(carried.hooks) : [];
  const parts = [
    ...(hooks.length ? [`hooks for ${hooks.join(", ")}`] : []),
    ...(sizeOf(carried, "permissions") ? [plural(sizeOf(carried, "permissions"), "permission rule")] : []),
    ...(sizeOf(carried, "env") ? [plural(sizeOf(carried, "env"), "env variable")] : []),
  ];
  return ok(tag, `${label} carries ${parts.length ? parts.join(", ") : "nothing"} into turns`);
}

export function checkClaude(options: ClaudeOptions): HostCheck[] {
  const bots = readJson(join(options.dataDir, "bots.json"));
  const checks: HostCheck[] = [skillsCheck(options)];
  for (const bot of Array.isArray(bots) ? bots as Array<{ id?: unknown; name?: unknown; cwd?: unknown }> : []) {
    if (typeof bot?.id !== "string") continue;
    const folder = typeof bot.cwd === "string" && bot.cwd ? bot.cwd : join(options.dataDir, "workspaces", bot.id);
    const check = botCheck(bot.id, typeof bot.name === "string" && bot.name ? bot.name : bot.id, join(folder, ".claude", "settings.json"));
    if (check) checks.push(check);
  }
  return checks;
}

export function claudeReport(checks: readonly HostCheck[]): VerbOutcome {
  const warnings = checks.filter((check) => check.status !== "ok").length;
  return {
    result: { ok: true, warnings, checks },
    exitCode: EXIT.done,
    human: [
      ...checks.flatMap((check) => [`${check.status.padEnd(6)}${check.message}`, ...(check.fix && check.status !== "ok" ? [`      fix: ${check.fix}`] : [])]),
      warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}.` : "Nothing to fix.",
    ],
  };
}

export async function claudeDoctor(ctx: VerbContext, home = homedir()): Promise<VerbOutcome> {
  const dataDir = flag(ctx.flags, "data-dir") ?? (ctx.env.OMB_DATA_DIR || join(home, ".openmausbot"));
  return claudeReport(checkClaude({ dataDir, home }));
}

export function checkClaudeFlags(ctx: VerbContext): void {
  if (ctx.flags.host === true) throw usageError("doctor takes --host or --claude, not both");
  if (flag(ctx.flags, "wait") !== undefined || flag(ctx.flags, "url") !== undefined) throw usageError("doctor --claude checks this machine: drop --wait and --url");
  if (flag(ctx.flags, "domain") !== undefined) throw usageError("--domain goes with doctor --host");
}
