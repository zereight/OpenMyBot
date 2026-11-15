#!/usr/bin/env node
// Brand rename: OpenMausBot -> OpenMyBot.
//
//   node scripts/brand-rename.mjs --check   list what is still named OpenMausBot (exit 1 if any)
//   node scripts/brand-rename.mjs --apply   rewrite the files in place and move the renamed files
//
// What is renamed: the product name as people read it and as code names it (OpenMausBot,
// openMausBot) and the entry point file (openmausbot.ts / openmausbot.js).
//
// What is NOT renamed, on purpose, because someone else (or an app that is already
// installed, or the user's disk) reads the old value:
//   - all-lowercase machine names: the `openmausbot` CLI, the `.openmausbot` data folder,
//     hosts, systemd units, localStorage keys, MCP server names, Docker labels, the
//     `openmausbot://` link scheme, the npm package and `@openmausbot/*` scope
//   - OPENMAUSBOT_* environment variables and x-openmausbot-* HTTP headers
//   - upstream repo, release and registry URLs (milind-soni/...)
//   - names derived from the OS product name (app bundle, installer files, install folders,
//     userData, Keychain item). electron-builder.yml, the release workflows and cloudflare/
//     stay as they are until the product name is migrated together with the user's data.
//   - LICENSE, NOTICE, CLA.md, LICENSING.md, enterprise/, third_party/ (legal text of the upstream project)
// When upstream is merged again: take upstream's side of any conflict, run --apply, run
// the brand-name guard test.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "./generate-locale.mjs";

/** Files this script never touches. */
export const SKIP_PATHS = [
  /^electron\/vendor\//, /^pnpm-lock\.yaml$/, /^cloudflare\//, /^LICENSE$/, /^NOTICE$/, /^CLA\.md$/, /^LICENSING\.md$/, /^enterprise\//, /^third_party\//,
  /^electron-builder\.yml$/, /^docs\/verification\/evidence\//,
  /^docs\/brand-rename\.md$/, /^scripts\/brand-rename\.mjs$/, /^src\/lib\/brand-name\.test\.ts$/,
];
/** Files that only get the entry point rename (they name build outputs). */
export const ENTRY_ONLY_PATHS = [/^\.github\/workflows\//];

/** Spans that keep the old name. Matched before the rename and put back after. */
export const KEEP = [
  // upstream and third-party repos
  /github\.com\/[\w.-]+\/OpenMausBot[\w.-]*/,
  /(?:milind-soni|Prudctual)\/OpenMausBot[\w.-]*/,
  // wire names, bundle ids
  /X-OpenMausBot-[\w-]*/,
  /com\.OpenMausBot[\w.-]*/,
  // names that come from the OS product name (kept together with productName)
  /OpenMausBot\.(?:app|exe|AppImage|dmg|deb|zip|msi|pkg|rpm|blockmap)\b/,
  /OpenMausBot-(?:\$|%|\{|\*|\d|arm64|x64|amd64|setup|mac|linux|win)/,
  /(?:Support|Roaming|Local|\.config|Logs|Caches|Applications|Programs|Program Files|MacOS|opt|release)\/OpenMausBot\b/,
  /OpenMausBot Safe Storage/,
  // protocol strings shared with the iOS app and other servers (case-insensitive schemes and hosts)
  /OpenMausBot phone credential/,
  /OpenMausBot:\/\//,
  /OpenMausBot\.(?:com|[Tt]est|invalid|local)\b/,
  /OpenMausBot (?:Speech|Recorder)/,
  /electron\.app\.OpenMausBot/,
  /OpenMausBot at login/,
  // the update feed's repository name
  /repo: ['"]?OpenMausBot/,
  /milind-soni\\\/OpenMausBot/,
  // folder names the OS product name gives (path segments written as separate strings)
  /"(?:Application Support|Roaming|Local|MacOS|opt|\/opt|Program Files|Logs|Caches)"\s*,\s*"OpenMausBot"/,
  /"openmausbot",\s*"OpenMausBot"/,
  /APPDATA \?\? "",\s*"OpenMausBot"/,
  /OpenMausBot\/(?:credentials\.bin|logs)\b/,
  /"OpenMausBot",\s*"(?:logs|credentials\.bin)"/,
  /join\((?:work|dir|root), "OpenMausBot"\)/,
];

const ENTRY = /openmausbot(?=\.(?:ts|js)\b)/g;
const BRAND = /OpenMausBot/g;
const BRAND_LOWER_FIRST = /openMausBot/g;

export function transform(text, { entryOnly = false } = {}) {
  let t = text.replace(ENTRY, "openmybot");
  if (entryOnly) return t;
  const saved = [];
  const keep = new RegExp(KEEP.map((r) => `(?:${r.source})`).join("|"), "g");
  t = t.replace(keep, (m) => `\uE000K${saved.push(m) - 1}\uE000`);
  t = t.replace(BRAND, "OpenMyBot").replace(BRAND_LOWER_FIRST, "openMyBot");
  return t.replace(/\uE000K(\d+)\uE000/g, (_, i) => saved[Number(i)]);
}

export function renamePath(path) {
  return path.replace(/(^|\/)openmausbot\.ts$/, "$1openmybot.ts");
}

function repoFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean);
}

/** Returns { files: [{ path, to, before, after }], moves: [{ from, to }] } for the whole repo. */
export function plan(root) {
  const files = [];
  const moves = [];
  for (const path of repoFiles(root)) {
    if (SKIP_PATHS.some((r) => r.test(path))) continue;
    const to = renamePath(path);
    if (to !== path) moves.push({ from: path, to });
    let buf;
    try { buf = readFileSync(join(root, path)); } catch { continue; }
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    if (!/openmausbot/i.test(text)) continue;
    const after = transform(text, { entryOnly: ENTRY_ONLY_PATHS.some((r) => r.test(path)) });
    if (after !== text) files.push({ path, to, before: text, after });
  }
  return { files, moves };
}

/** What is still named OpenMausBot outside the keep list: [{ path, line, text }]. */
export function leftovers(root) {
  const out = [];
  for (const path of repoFiles(root)) {
    if (SKIP_PATHS.some((r) => r.test(path)) || ENTRY_ONLY_PATHS.some((r) => r.test(path))) continue;
    let buf;
    try { buf = readFileSync(join(root, path)); } catch { continue; }
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    if (!/openmausbot/i.test(text)) continue;
    const t = transform(text);
    if (t === text) continue;
    const a = text.split("\n"), b = t.split("\n");
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push({ path, line: i + 1, text: a[i].trim().slice(0, 160) });
  }
  return out;
}

/** The locale check (pnpm i18n:check) marks a translation stale when its English source changed. The rename changed the
 * English and the translations alike, so the recorded hash of a key whose English only changed by the rename is moved
 * to the new English. Keys whose English changed for any other reason stay stale. */
export function refreshLocaleHashes(root, oldEnglish) {
  const enPath = join(root, "src/locales/en.json");
  const hashPath = join(root, "src/locales/source-hashes.json");
  if (!existsSync(enPath) || !existsSync(hashPath)) return 0;
  const english = JSON.parse(readFileSync(enPath, "utf8"));
  const state = JSON.parse(readFileSync(hashPath, "utf8"));
  let moved = 0;
  for (const hashes of Object.values(state.locales ?? {})) {
    for (const key of Object.keys(hashes)) {
      const before = oldEnglish[key];
      if (before === undefined || english[key] === undefined || before === english[key]) continue;
      if (hashes[key] !== sourceHash(before)) continue;
      hashes[key] = sourceHash(english[key]);
      moved += 1;
    }
  }
  if (moved) writeFileSync(hashPath, `${JSON.stringify(state, null, 2)}\n`);
  return moved;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const apply = process.argv.includes("--apply");
  const { files, moves } = plan(root);
  if (!apply) {
    for (const f of files.slice(0, 20)) console.log(f.path);
    console.log(`${files.length} files would change, ${moves.length} would move`);
    process.exit(files.length || moves.length ? 1 : 0);
  }
  const enPath = join(root, "src/locales/en.json");
  const oldEnglish = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};
  for (const f of files) writeFileSync(join(root, f.path), f.after);
  for (const m of moves) {
    mkdirSync(dirname(join(root, m.to)), { recursive: true });
    if (existsSync(join(root, m.from))) execFileSync("git", ["-C", root, "mv", m.from, m.to]);
  }
  const hashes = refreshLocaleHashes(root, oldEnglish);
  console.log(`rewrote ${files.length} files, moved ${moves.length}, refreshed ${hashes} locale hashes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
