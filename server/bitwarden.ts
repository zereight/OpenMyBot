// Bitwarden through the `bw` CLI on the person's own computer.
//
// Security: a personal Bitwarden vault has no long-lived, narrow token like a 1Password service account; a session key
// opens the whole vault, organisation collections included. So nothing here lives longer than an unlock:
// - the master password goes to `bw` on stdin (`--passwordfile /dev/stdin`), never in its environment or arguments,
//   which any process of the same user can read with `ps eww` while `bw` runs;
// - the session key exists only for the few seconds of one unlock: `bw` reads the chosen folder once and is locked
//   again at once (`bw lock`), which makes the key useless even if it was seen;
// - what the folder holds stays in this process's memory until the app stops or the person locks it, and is never
//   written anywhere. A restart locks it again.
// Only one folder is read, and every item is checked against it again, since `bw get item` returns any item at all.
import { spawn } from "node:child_process";

import { BITWARDEN_ID, loginSite, normalizeLoginHost, type BitwardenChoice, type BitwardenStatus, type LoginBots, type LoginPlace } from "../shared/logins.ts";
import { parseTotpKey, type TotpKey } from "./totp.ts";
import type { LinkedItem, LinkedValue, VaultProvider } from "./vault/providers.ts";

/** One `bw` run: its stdout, or a BitwardenError. `input` goes to stdin; `session` is the only secret in the environment. */
export type BwRun = (args: readonly string[], options?: { input?: string; session?: string }) => Promise<string>;

export type BitwardenProblem = "missing" | "password" | "logged-out" | "failed" | "timeout";

export class BitwardenError extends Error {
  readonly problem: BitwardenProblem;
  constructor(problem: BitwardenProblem) {
    super(BITWARDEN_WORDS[problem]);
    this.name = "BitwardenError";
    this.problem = problem;
  }
}

export const BITWARDEN_WORDS: Record<BitwardenProblem, string> = {
  missing: "The Bitwarden CLI (bw) is not installed on this computer. Install it (for example brew install bitwarden-cli), sign in once with bw login in a terminal, then try again.",
  password: "That master password did not unlock Bitwarden.",
  "logged-out": "The Bitwarden CLI on this computer is not signed in. Run bw login in a terminal once, then unlock here.",
  failed: "Bitwarden could not be read just now. Try again in a moment.",
  timeout: "Bitwarden took too long to answer. Try again in a moment.",
};

const RUN_MS = 60_000;
const OUTPUT_MAX = 64 * 1024 * 1024;

/** What `bw` printed on stderr is matched to a problem and dropped: it can quote what it failed on. */
export function bitwardenProblemOf(stderr: string): BitwardenProblem {
  if (/not logged in|you are not logged|login required/iu.test(stderr)) return "logged-out";
  if (/invalid master password|decryption operation failed|master password/iu.test(stderr)) return "password";
  return "failed";
}

export function spawnBw(command = "bw", env: NodeJS.ProcessEnv = process.env): BwRun {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const { BW_SESSION: _theirs, BW_PASSWORD: _password, ...rest } = env;
    const child = spawn(command, [...args], {
      env: { ...rest, BW_NOINTERACTION: "true", ...(options.session ? { BW_SESSION: options.session } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const finish = (fail: BitwardenError | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fail) { child.kill("SIGKILL"); reject(fail); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new BitwardenError("timeout")), RUN_MS);
    child.on("error", (error: NodeJS.ErrnoException) => finish(new BitwardenError(error.code === "ENOENT" ? "missing" : "failed")));
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > OUTPUT_MAX) return finish(new BitwardenError("failed"));
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (err.length < 8192) err += chunk.toString("utf8"); });
    child.on("close", (code) => (code === 0 ? finish(null, Buffer.concat(out).toString("utf8")) : finish(new BitwardenError(bitwardenProblemOf(err)))));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/** Bitwarden's item as `bw list items` prints it, only the parts read here. */
interface BwField { name?: string | null; value?: string | null; type?: number }
interface BwUri { uri?: string | null; match?: number | null }
export interface BwItem {
  id: string;
  folderId?: string | null;
  type: number;
  name?: string | null;
  notes?: string | null;
  deletedDate?: string | null;
  fields?: BwField[] | null;
  login?: { username?: string | null; password?: string | null; totp?: string | null; uris?: BwUri[] | null } | null;
}

const LOGIN = 1;
const SECURE_NOTE = 2;
/** Text and hidden custom fields only: a boolean's "true" would be masked everywhere once held, and a linked field has no value. */
const FIELD_TEXT = new Set([0, 1]);
/** URI match: 0 base domain (also the default), 1 host, 2 starts with, 3 exact, 4 regular expression, 5 never. */
const MATCH_EXACT_HOST = new Set([1, 2, 3]);
const MATCH_SKIPPED = new Set([4, 5]);
const MAX_ITEMS = 500;
const FIELDS_MAX = 20;
const ID_PREFIX = "bitwarden:";

interface LoginEntry extends LoginPlace {
  id: string;
  itemId: string;
  username: string;
  password: string;
  totp: TotpKey | null;
}

interface SecretEntry {
  id: string;
  itemId: string;
  name: string;
  /** "" is its main value. */
  values: Map<string, string>;
}

function customFields(fields: readonly BwField[] | null | undefined): Map<string, string> {
  const usable = (fields ?? []).filter((field) => FIELD_TEXT.has(field.type ?? -1) && field.value && field.name?.trim());
  const values = new Map<string, string>();
  const main = usable.find((field) => field.type === 1) ?? usable[0];
  if (main) values.set("", main.value!);
  for (const field of usable) if (!values.has(field.name!.trim()) && values.size <= FIELDS_MAX) values.set(field.name!.trim(), field.value!);
  return values;
}

/** Where a login fills: its URIs grouped by site, those matched by host, start or exact address on their own hosts only. */
export function loginPlaces(uris: readonly BwUri[] | null | undefined): LoginPlace[] {
  const places = new Map<string, LoginPlace>();
  for (const { uri, match } of uris ?? []) {
    if (match != null && MATCH_SKIPPED.has(match)) continue;
    const host = normalizeLoginHost(uri ?? "");
    if (!host) continue;
    const exactHost = match != null && MATCH_EXACT_HOST.has(match);
    const site = loginSite(host);
    const key = `${site}\0${exactHost}`;
    const place = places.get(key) ?? { site, hosts: [], exactHost };
    if (!place.hosts.includes(host)) place.hosts.push(host);
    places.set(key, place);
  }
  return [...places.values()];
}

/** The folder's logins and secrets. Notes of a login, cards, identities and SSH keys are left out, and a login's 2FA key
 * is only ever filled, never handed to a bot as a secret. */
export function snapshotOf(items: readonly BwItem[], folderId: string): { logins: LoginEntry[]; secrets: SecretEntry[] } {
  const logins: LoginEntry[] = [];
  const secrets: SecretEntry[] = [];
  const mine = items.filter((item) => item.folderId === folderId && !item.deletedDate && BITWARDEN_ID.test(item.id)).slice(0, MAX_ITEMS);
  for (const item of mine) {
    const name = item.name?.trim() || (item.type === LOGIN ? "Login" : "Note");
    if (item.type === LOGIN) {
      const extra = customFields(item.fields);
      if (extra.has("")) secrets.push({ id: `${ID_PREFIX}${item.id}`, itemId: item.id, name, values: extra });
      const password = item.login?.password ?? "";
      if (!password) continue;
      const totp = item.login?.totp ? parseTotpKey(item.login.totp) : null;
      for (const place of loginPlaces(item.login?.uris)) {
        logins.push({ ...place, id: `${ID_PREFIX}${item.id}:${place.site}${place.exactHost ? ":exact" : ""}`, itemId: item.id,
          username: item.login?.username ?? "", password, totp });
      }
    } else if (item.type === SECURE_NOTE) {
      const values = customFields(item.fields);
      const note = item.notes?.trim();
      if (note) values.set("", note);
      if (values.has("")) secrets.push({ id: `${ID_PREFIX}${item.id}`, itemId: item.id, name, values });
    }
  }
  logins.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
  secrets.sort((a, b) => a.name.localeCompare(b.name));
  return { logins, secrets };
}

export function isBitwardenId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** Wrong master passwords in a row before the next try waits, doubling each time up to `BACKOFF_MAX_MS`. */
const FREE_TRIES = 5;
const BACKOFF_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export class BitwardenLogins implements VaultProvider {
  readonly id = "bitwarden";
  readonly label = "Bitwarden";
  private readonly run: BwRun;
  private readonly choice: () => BitwardenChoice | null;
  private readonly available: () => boolean;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private logins: LoginEntry[] = [];
  private secrets: SecretEntry[] = [];
  /** The folder the loaded items came from; they are dropped when another one is chosen. */
  private loadedFolder: string | null = null;
  private unlockedAt: number | null = null;
  private folders: Array<{ id: string; name: string }> = [];
  private installed: boolean | undefined;
  private error: string | undefined;
  private failures = 0;
  private waitUntil = 0;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: { run: BwRun; choice: () => BitwardenChoice | null; available: () => boolean; now?: () => number }) {
    this.run = options.run;
    this.choice = options.choice;
    this.available = options.available;
    this.now = options.now ?? Date.now;
  }

  /** One `bw` at a time: they share one data file. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private loaded(): boolean {
    const choice = this.choice();
    return this.available() && choice !== null && this.loadedFolder === choice.folderId;
  }

  status(): BitwardenStatus {
    if (!this.available()) return { available: false, unlocked: false };
    const choice = this.choice();
    const unlocked = this.loaded();
    return {
      available: true,
      ...(this.installed === undefined ? {} : { installed: this.installed }),
      ...(choice ? { folder: { id: choice.folderId, name: choice.folderName }, bots: choice.bots } : {}),
      ...(this.folders.length ? { folders: this.folders.map((folder) => ({ ...folder })) } : {}),
      unlocked,
      ...(unlocked ? { logins: new Set(this.logins.map((login) => login.itemId)).size, secrets: this.secrets.length, unlockedAt: this.unlockedAt ?? undefined } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Why a bot finds no Bitwarden login: it was chosen but is locked, as after every restart. */
  trouble(): string | undefined {
    if (!this.available() || !this.choice() || this.loaded()) return undefined;
    return "Bitwarden is locked. The person unlocks it in Settings → Vault; it locks again whenever OpenMausBot restarts.";
  }

  /** Unlocks with the master password, reads the folders and the chosen folder's items, and locks `bw` again. */
  async unlock(password: string): Promise<BitwardenStatus> {
    if (!this.available()) throw new BitwardenError("failed");
    const wait = this.waitUntil - this.now();
    if (wait > 0) throw new Error(`Too many wrong master passwords. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    return await this.serial(async () => {
      let session: string;
      try {
        session = (await this.run(["unlock", "--passwordfile", "/dev/stdin", "--raw"], { input: `${password}\n` })).trim();
        this.installed = true;
      } catch (error) {
        if (error instanceof BitwardenError && error.problem === "missing") this.installed = false;
        if (error instanceof BitwardenError && error.problem === "password") this.wrongPassword();
        throw error instanceof BitwardenError ? error : new BitwardenError("failed");
      }
      if (!session) throw new BitwardenError("failed");
      this.failures = 0;
      this.waitUntil = 0;
      try {
        await this.run(["sync"], { session }).catch(() => {});
        const folders = JSON.parse(await this.run(["list", "folders"], { session })) as Array<{ id?: unknown; name?: unknown }>;
        this.folders = folders.flatMap((folder) => (typeof folder.id === "string" && BITWARDEN_ID.test(folder.id)
          ? [{ id: folder.id, name: typeof folder.name === "string" && folder.name.trim() ? folder.name.trim().slice(0, 512) : folder.id }] : []))
          .sort((a, b) => a.name.localeCompare(b.name));
        const choice = this.choice();
        if (choice && this.folders.some((folder) => folder.id === choice.folderId)) {
          // Only this folder's items reach this process, never the rest of the vault.
          const items = JSON.parse(await this.run(["list", "items", "--folderid", choice.folderId], { session })) as BwItem[];
          const { logins, secrets } = snapshotOf(Array.isArray(items) ? items : [], choice.folderId);
          this.logins = logins;
          this.secrets = secrets;
          this.loadedFolder = choice.folderId;
          this.unlockedAt = this.now();
        } else {
          this.drop();
        }
        this.error = undefined;
      } catch (error) {
        this.drop();
        this.error = error instanceof BitwardenError ? error.message : BITWARDEN_WORDS.failed;
      } finally {
        // The key this unlock made stops working here, whatever happened above.
        await this.run(["lock"], { session }).catch(() => {});
      }
      return this.status();
    });
  }

  private wrongPassword(): void {
    this.failures++;
    if (this.failures >= FREE_TRIES) this.waitUntil = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.failures - FREE_TRIES));
  }

  private drop(): void {
    this.logins = [];
    this.secrets = [];
    this.loadedFolder = null;
    this.unlockedAt = null;
    this.lastUsed.clear();
  }

  /** Forgets every loaded item; the folder choice stays. */
  lock(): BitwardenStatus {
    this.drop();
    this.error = undefined;
    return this.status();
  }

  /** A folder seen at the last unlock, or null: a folder is chosen only from those. */
  hasFolder(folderId: string): { id: string; name: string } | null {
    return BITWARDEN_ID.test(folderId) ? this.folders.find((folder) => folder.id === folderId) ?? null : null;
  }

  /** Forgets the choice and the list of folders too. */
  forget(): void {
    this.drop();
    this.folders = [];
    this.error = undefined;
  }

  async fresh(): Promise<void> {}

  private bots(): LoginBots {
    return this.choice()?.bots ?? [];
  }

  private lastUsedOf(itemId: string): { lastUsedAt?: number } {
    const at = this.lastUsed.get(itemId);
    return at === undefined ? {} : { lastUsedAt: at };
  }

  items(): LinkedItem[] {
    if (!this.loaded()) return [];
    const bots = this.bots();
    return [
      ...this.logins.map((login): LinkedItem => ({
        kind: "login", id: login.id, site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username,
        hasTotp: login.totp !== null, source: "bitwarden", bots, createdAt: 0, ...this.lastUsedOf(login.itemId),
      })),
      ...this.secrets.map((secret): LinkedItem => ({
        kind: "secret", id: secret.id, name: secret.name, fields: [...secret.values.keys()].filter(Boolean), source: "linked", provider: this.id,
        bots, readOnly: true, ...this.lastUsedOf(secret.itemId),
      })),
    ];
  }

  async read(itemId: string, field?: string): Promise<LinkedValue> {
    if (!this.loaded()) return {};
    const login = this.logins.find((entry) => entry.id === itemId);
    if (login) return { password: login.password, totp: login.totp };
    const value = this.secrets.find((entry) => entry.id === itemId)?.values.get(field ?? "");
    return value ? { value } : {};
  }

  markUsed(id: string): void {
    const entry = this.logins.find((candidate) => candidate.id === id) ?? this.secrets.find((candidate) => candidate.id === id);
    if (entry) this.lastUsed.set(entry.itemId, this.now());
  }
}

/** The app's own Bitwarden: only in the desktop app (`desktop`), where every change must carry the app's own token, since
 * anywhere else a local process could try master passwords or widen the folder; never on Windows, which has no /dev/stdin
 * and runs bw from npm as a .cmd file that needs a shell. It locks again on every restart. */
export function desktopBitwarden(choice: () => BitwardenChoice | null, desktop: () => boolean): BitwardenLogins {
  return new BitwardenLogins({ run: spawnBw(), choice, available: () => process.platform !== "win32" && desktop() });
}
