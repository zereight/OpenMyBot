import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BitwardenChoice } from "../shared/logins.ts";
import { BitwardenError, BitwardenLogins, bitwardenProblemOf, loginPlaces, snapshotOf, spawnBw, type BwItem, type BwRun } from "./bitwarden.ts";
import { BotLogins } from "./bot-logins.ts";
import { json, readBody } from "./harness/http.ts";
import { OnePasswordLogins } from "./onepassword.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createLoginRoutes } from "./routes/logins.ts";
import { dispatchRoutes } from "./routes/table.ts";
import { linkedCandidates, linkedSecrets, findLinkedSecret, readLinkedSecret } from "./vault/providers.ts";
import { VaultStore } from "./vault-store.ts";

// Obvious fakes only; no real bw, no network.
const MASTER = "fake-master-password-123";
const SESSION = "fake-session-key-abc";
const BOTS_FOLDER = "11111111-1111-4111-8111-111111111111";
const OTHER_FOLDER = "22222222-2222-4222-8222-222222222222";
const SITE_PASSWORD = "fake-site-password-1";
const API_KEY = "fake-api-key-xyz";
const TOTP = "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const ITEMS: BwItem[] = [
  { id: id(1), folderId: BOTS_FOLDER, type: 1, name: "Example", login: { username: "alice", password: SITE_PASSWORD, totp: TOTP,
    uris: [{ uri: "https://accounts.example.com/login", match: null }, { uri: "https://admin.example.org", match: 1 }, { uri: "^https://.*", match: 4 }, { uri: "https://never.example.net", match: 5 }] },
    fields: [{ name: "API key", value: API_KEY, type: 1 }, { name: "flag", value: "true", type: 2 }, { name: "linked", value: null, type: 3 }] },
  { id: id(2), folderId: BOTS_FOLDER, type: 2, name: "Deploy note", notes: "fake-note-text" },
  { id: id(3), folderId: BOTS_FOLDER, type: 3, name: "A card" },
  { id: id(4), folderId: OTHER_FOLDER, type: 1, name: "Bank", login: { username: "me", password: "fake-other", uris: [{ uri: "https://bank.example.com" }] } },
  { id: id(5), folderId: BOTS_FOLDER, type: 1, name: "Deleted", deletedDate: "2026-01-01", login: { password: "x", uris: [{ uri: "https://gone.example.com" }] } },
  { id: id(6), folderId: BOTS_FOLDER, type: 1, name: "Steam", login: { username: "s", password: "fake-steam", totp: "steam://ABCDEF", uris: [{ uri: "https://store.example.com" }] } },
];

interface Call { args: string[]; input?: string; session?: string }

function fakeBw(options: { password?: string; items?: BwItem[]; folders?: Array<{ id: string | null; name: string }>; fail?: (args: string[]) => BitwardenError | null } = {}) {
  const calls: Call[] = [];
  const run: BwRun = async (args, opts = {}) => {
    calls.push({ args: [...args], ...(opts.input === undefined ? {} : { input: opts.input }), ...(opts.session ? { session: opts.session } : {}) });
    const failure = options.fail?.([...args]);
    if (failure) throw failure;
    if (args[0] === "unlock") {
      if (opts.input !== `${options.password ?? MASTER}\n`) throw new BitwardenError("password");
      return `${SESSION}\n`;
    }
    if (opts.session !== SESSION) throw new BitwardenError("failed");
    if (args[0] === "sync" || args[0] === "lock") return "";
    if (args[0] === "list" && args[1] === "folders") return JSON.stringify(options.folders ?? [{ id: null, name: "No Folder" }, { id: BOTS_FOLDER, name: "Bots" }, { id: OTHER_FOLDER, name: "Personal" }]);
    // Like `bw`, the folder filter is trusted only after it is checked again.
    if (args[0] === "list" && args[1] === "items") return JSON.stringify(options.items ?? ITEMS);
    throw new BitwardenError("failed");
  };
  return { run, calls };
}

function setup(options: Parameters<typeof fakeBw>[0] & { choice?: BitwardenChoice | null; available?: boolean } = {}) {
  const bw = fakeBw(options);
  let choice: BitwardenChoice | null = options.choice === undefined ? { folderId: BOTS_FOLDER, folderName: "Bots", bots: ["pepper"] } : options.choice;
  let clock = 1_000_000;
  const source = new BitwardenLogins({ run: bw.run, choice: () => choice, available: () => options.available ?? true, now: () => clock });
  return { source, calls: bw.calls, setChoice: (value: BitwardenChoice | null) => { choice = value; }, tick: (ms: number) => { clock += ms; } };
}

describe("a Bitwarden folder's items", () => {
  it("keep only the chosen folder's live logins and notes, re-checked against the folder", () => {
    const { logins, secrets } = snapshotOf(ITEMS, BOTS_FOLDER);
    expect(new Set(logins.map((login) => login.itemId))).toEqual(new Set([id(1), id(6)]));
    expect(secrets.map((secret) => secret.name)).toEqual(["Deploy note", "Example"]);
    expect(JSON.stringify({ logins, secrets: secrets.map((s) => [...s.values]) })).not.toContain("fake-other");
  });

  it("hand a bot only text and hidden custom fields as secrets, never the 2FA key", () => {
    const { secrets, logins } = snapshotOf(ITEMS, BOTS_FOLDER);
    const example = secrets.find((secret) => secret.name === "Example")!;
    expect([...example.values]).toEqual([["", API_KEY], ["API key", API_KEY]]);
    expect(JSON.stringify(secrets.map((s) => [...s.values]))).not.toContain("JBSWY3DP");
    expect(logins.find((login) => login.itemId === id(1))!.totp?.secret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    // A Steam Guard key is not a standard TOTP key and is never offered as one.
    expect(logins.find((login) => login.itemId === id(6))!.totp).toBeNull();
  });

  it("fill on base domains by default, on their own hosts for host, starts-with and exact rules, and never on regex or never rules", () => {
    expect(loginPlaces([{ uri: "https://accounts.example.com/login" }, { uri: "https://admin.example.org", match: 1 }, { uri: "https://x.example.io/a", match: 3 },
      { uri: "^https://.*", match: 4 }, { uri: "https://never.example.net", match: 5 }])).toEqual([
      { site: "example.com", hosts: ["accounts.example.com"], exactHost: false },
      { site: "example.org", hosts: ["admin.example.org"], exactHost: true },
      { site: "example.io", hosts: ["x.example.io"], exactHost: true },
    ]);
  });

  it("read bw's errors as plain problems without repeating them", () => {
    expect(bitwardenProblemOf("Invalid master password.")).toBe("password");
    expect(bitwardenProblemOf("You are not logged in.")).toBe("logged-out");
    expect(bitwardenProblemOf("something with fake-secret in it")).toBe("failed");
    expect(new BitwardenError("failed").message).not.toContain("fake-secret");
  });
});

describe("unlocking Bitwarden", () => {
  it("gives the master password only on stdin, reads only the chosen folder, and locks bw again", async () => {
    const { source, calls } = setup();
    const status = await source.unlock(MASTER);
    expect(status).toMatchObject({ available: true, installed: true, unlocked: true, logins: 2, secrets: 2, folder: { id: BOTS_FOLDER, name: "Bots" } });
    expect(status.folders).toEqual([{ id: BOTS_FOLDER, name: "Bots" }, { id: OTHER_FOLDER, name: "Personal" }]);
    expect(calls.map((call) => call.args.join(" "))).toEqual(["unlock --passwordfile /dev/stdin --raw", "sync", "list folders", `list items --folderid ${BOTS_FOLDER}`, "lock"]);
    expect(calls[0]!.input).toBe(`${MASTER}\n`);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(MASTER);
    for (const call of calls.slice(1)) { expect(call.session).toBe(SESSION); expect(call.input).toBeUndefined(); }
    expect(JSON.stringify(status)).not.toContain(SITE_PASSWORD);
  });

  it("lets the chosen bots fill and read, and nobody else", async () => {
    const { source } = setup();
    await source.unlock(MASTER);
    expect(linkedCandidates(source, "accounts.example.com", "quill")).toEqual([]);
    const [candidate] = linkedCandidates(source, "login.example.com", "pepper");
    expect(candidate).toMatchObject({ username: "alice", source: "bitwarden" });
    expect((await candidate!.secrets()).password).toBe(SITE_PASSWORD);
    expect(linkedCandidates(source, "www.example.org", "pepper")).toEqual([]);
    expect(linkedCandidates(source, "admin.example.org", "pepper")).toHaveLength(1);
    expect(linkedSecrets(source, "pepper").map((secret) => secret.name)).toEqual(["Deploy note", "Example"]);
    const use = findLinkedSecret([source], "Example API key", "pepper");
    expect(use && await readLinkedSecret(use)).toBe(API_KEY);
    expect(findLinkedSecret([source], "Example API key", "quill")).toBeNull();
  });

  it("locks bw even when reading fails, and keeps nothing", async () => {
    const { source, calls } = setup({ fail: (args) => (args[0] === "list" && args[1] === "items" ? new BitwardenError("timeout") : null) });
    const status = await source.unlock(MASTER);
    expect(status.unlocked).toBe(false);
    expect(status.error).toBe(new BitwardenError("timeout").message);
    expect(calls.at(-1)!.args).toEqual(["lock"]);
    expect(source.items()).toEqual([]);
  });

  it("lists folders without loading items until one is chosen, and drops a folder bw no longer has", async () => {
    const none = setup({ choice: null });
    expect((await none.source.unlock(MASTER)).unlocked).toBe(false);
    expect(none.calls.some((call) => call.args[1] === "items")).toBe(false);
    expect(none.source.hasFolder(OTHER_FOLDER)).toEqual({ id: OTHER_FOLDER, name: "Personal" });
    expect(none.source.hasFolder("null")).toBeNull();

    const gone = setup({ folders: [{ id: OTHER_FOLDER, name: "Personal" }] });
    expect((await gone.source.unlock(MASTER)).unlocked).toBe(false);
    expect(gone.calls.some((call) => call.args[1] === "items")).toBe(false);
  });

  it("forgets loaded items on lock and when another folder is chosen", async () => {
    const { source, setChoice } = setup();
    await source.unlock(MASTER);
    expect(source.items().length).toBeGreaterThan(0);
    setChoice({ folderId: OTHER_FOLDER, folderName: "Personal", bots: "all" });
    expect(source.items()).toEqual([]);
    expect(await source.read(`bitwarden:${id(1)}:example.com`)).toEqual({});
    expect(source.trouble()).toContain("locked");
    setChoice({ folderId: BOTS_FOLDER, folderName: "Bots", bots: ["pepper"] });
    source.lock();
    expect(source.items()).toEqual([]);
  });

  it("waits after five wrong master passwords, doubling the wait", async () => {
    const { source, tick } = setup();
    for (let i = 0; i < 5; i++) await expect(source.unlock("wrong")).rejects.toThrow(new BitwardenError("password").message);
    await expect(source.unlock(MASTER)).rejects.toThrow(/Try again in 30 seconds/u);
    tick(30_000);
    await expect(source.unlock("wrong")).rejects.toThrow(new BitwardenError("password").message);
    await expect(source.unlock(MASTER)).rejects.toThrow(/Try again in 60 seconds/u);
    tick(60_000);
    expect((await source.unlock(MASTER)).unlocked).toBe(true);
    await expect(source.unlock("wrong")).rejects.toThrow(new BitwardenError("password").message);
    expect((await source.unlock(MASTER)).unlocked).toBe(true);
  });

  it("is off where it is not available", async () => {
    const { source, calls } = setup({ available: false });
    expect(source.status()).toEqual({ available: false, unlocked: false });
    await expect(source.unlock(MASTER)).rejects.toBeInstanceOf(BitwardenError);
    expect(calls).toEqual([]);
  });
});

describe("running bw", () => {
  it("passes stdin, keeps BW_SESSION and BW_PASSWORD from the environment, and says when bw is missing", async () => {
    const run = spawnBw(process.execPath, { PATH: process.env.PATH, BW_SESSION: "theirs", BW_PASSWORD: "theirs-too" });
    const out = await run(["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({s,session:process.env.BW_SESSION??null,password:process.env.BW_PASSWORD??null,argv:process.argv.slice(1)})))"],
      { input: `${MASTER}\n` });
    expect(JSON.parse(out)).toEqual({ s: `${MASTER}\n`, session: null, password: null, argv: [] });
    const withSession = await spawnBw(process.execPath, { PATH: process.env.PATH })(["-e", "process.stdout.write(process.env.BW_SESSION)"], { session: SESSION });
    expect(withSession).toBe(SESSION);
    await expect(spawnBw("/nonexistent/bw-fake")(["status"])).rejects.toMatchObject({ problem: "missing" });
    await expect(spawnBw(process.execPath, { PATH: process.env.PATH })(["-e", "console.error('Invalid master password. '+process.argv.length);process.exit(1)"]))
      .rejects.toMatchObject({ problem: "password" });
  });
});

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(withBitwarden: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "omb-bitwarden-routes-"));
  dirs.push(dir);
  const store = new VaultStore({ dataDir: dir });
  const onePassword = new OnePasswordLogins({ token: () => null, connect: async () => { throw new Error("no"); } });
  const bw = fakeBw();
  const bitwarden = withBitwarden ? new BitwardenLogins({ run: bw.run, choice: () => store.bitwarden(), available: () => true }) : null;
  const logins = new BotLogins(store, onePassword, () => [], () => {}, bitwarden);
  const routes = [createLoginRoutes(logins.routes((bot) => ["pepper", "quill"].includes(bot)))];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const answers: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { store, logins, call, answers, calls: bw.calls };
}

describe("Settings → Vault Bitwarden routes", () => {
  it("are absent outside the desktop app", async () => {
    const { call } = await serve(false);
    expect((await call("GET", "/api/logins/bitwarden")).status).toBe(404);
    expect((await call("POST", "/api/logins/bitwarden/unlock", { password: MASTER })).status).toBe(404);
    expect((await call("GET", "/api/logins")).body).not.toHaveProperty("bitwarden");
  });

  it("unlock, choose a folder, give it to bots, list read-only logins, lock and forget, never answering with a password", async () => {
    const { call, answers, store, calls, logins } = await serve(true);
    expect((await call("POST", "/api/logins/bitwarden/unlock", { password: "" })).status).toBe(400);
    expect((await call("POST", "/api/logins/bitwarden/unlock", { password: "a\nb" })).status).toBe(400);
    expect((await call("POST", "/api/logins/bitwarden/unlock", { password: "wrong" })).body.error).toBe(new BitwardenError("password").message);
    expect((await call("PUT", "/api/logins/bitwarden/folder", { folderId: BOTS_FOLDER })).status).toBe(404);

    const first = await call("POST", "/api/logins/bitwarden/unlock", { password: MASTER });
    expect(first.body.bitwarden).toMatchObject({ unlocked: false, folders: [{ id: BOTS_FOLDER, name: "Bots" }, { id: OTHER_FOLDER, name: "Personal" }] });
    expect((await call("PUT", "/api/logins/bitwarden/folder", { folderId: "33333333-3333-4333-8333-333333333333" })).status).toBe(404);
    const chosen = await call("PUT", "/api/logins/bitwarden/folder", { folderId: BOTS_FOLDER });
    expect(chosen.body.bitwarden).toMatchObject({ folder: { id: BOTS_FOLDER, name: "Bots" }, bots: [], unlocked: false });
    expect(store.bitwarden()).toEqual({ folderId: BOTS_FOLDER, folderName: "Bots", bots: [] });

    expect((await call("PATCH", "/api/logins/bitwarden/bots", { bots: ["nobody"] })).status).toBe(400);
    expect((await call("PATCH", "/api/logins/bitwarden/bots", { bots: ["pepper"] })).body.bitwarden.bots).toEqual(["pepper"]);
    expect((await call("POST", "/api/logins/bitwarden/unlock", { password: MASTER })).body.bitwarden).toMatchObject({ unlocked: true, logins: 2, secrets: 2 });

    const list = await call("GET", "/api/logins");
    const mine = list.body.logins.filter((login: { source: string }) => login.source === "bitwarden");
    expect(new Set(mine.map((login: { site: string }) => login.site))).toEqual(new Set(["example.com", "example.org"]));
    expect((await call("DELETE", `/api/logins/${encodeURIComponent(mine[0].id)}`)).status).toBe(409);
    expect(logins.lockedLogins()).toBeUndefined();

    expect((await call("POST", "/api/logins/bitwarden/lock")).body.bitwarden.unlocked).toBe(false);
    expect(logins.lockedLogins()).toContain("locked");
    expect((await call("DELETE", "/api/logins/bitwarden")).body.bitwarden).toEqual({ available: true, installed: true, unlocked: false });
    expect(store.bitwarden()).toBeNull();

    for (const text of answers) for (const secret of [MASTER, SITE_PASSWORD, API_KEY, SESSION, "fake-note-text"]) expect(text).not.toContain(secret);
    expect(calls.filter((c) => c.args[0] === "unlock").every((c) => !c.args.join(" ").includes(MASTER))).toBe(true);
  });
});
