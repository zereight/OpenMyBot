// Claude Code writes "Co-Authored-By: Claude Code" into commits and PRs unless `attribution` (or the older
// `includeCoAuthoredBy`) says otherwise. An isolated turn runs with --setting-sources project, so the person's own
// opt-out would be lost; it travels in the turn's --settings file instead. That file outranks project settings, so
// keys the turn's project already sets are left out and Claude Code keeps reading them itself.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Attribution = { commit?: string; pr?: string; sessionUrl?: boolean };

const FILE_MAX_BYTES = 1024 * 1024;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The attribution a settings object asks for, keeping only fields of the type Claude Code accepts (it drops a
 * whole settings file over a wrong type). `false` means no attribution; `true` and anything else mean nothing. */
export function attributionOf(settings: Record<string, unknown> | null | undefined): Attribution {
  if (!settings) return {};
  const out: Attribution = {};
  if (settings.includeCoAuthoredBy === false) Object.assign(out, { commit: "", pr: "" });
  const value = settings.attribution;
  if (value === false) return { commit: "", pr: "", sessionUrl: false };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const own = value as Record<string, unknown>;
    if (typeof own.commit === "string") out.commit = own.commit;
    if (typeof own.pr === "string") out.pr = own.pr;
    if (typeof own.sessionUrl === "boolean") out.sessionUrl = own.sessionUrl;
  }
  return out;
}

/** What to put in --settings: the person's account settings, then the bot's, with the folder's own local settings
 * on top (Claude Code does not read them in this mode), minus every key the folder's project settings define. */
export function attributionToCarry(configDir: string, cwd: string, bot: Attribution | undefined): Attribution | undefined {
  const user = attributionOf(readJson(join(configDir, "settings.json")));
  const local = attributionOf(readJson(join(cwd, ".claude", "settings.local.json")));
  const project = attributionOf(readJson(join(cwd, ".claude", "settings.json")));
  const merged: Attribution = { ...user, ...bot, ...local };
  for (const key of Object.keys(project) as (keyof Attribution)[]) delete merged[key];
  return Object.keys(merged).length ? merged : undefined;
}
