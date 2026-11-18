import {
  chromeForTestingPlatform,
  fetchLatestChromeForTesting,
  installLatestChromeForTesting,
  pruneOldChromeForTestingVersions,
  type ChromeForTestingRelease,
  type DownloadProgress,
} from "./install.ts";
import type { ChromeLauncher } from "./launcher.ts";
import { compareVersions, scanLocalProfileChromeVersions, type LocalProfileVersionSummary } from "./profile.ts";
import type { ChromeSource } from "./resolve.ts";

export type BrowserChromeUpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "extracting"
  | "verifying"
  | "switching"
  | "done"
  | "error";

export interface BrowserChromeStatus {
  currentVersion: string | null;
  currentSource: ChromeSource | "legacy" | null;
  currentDescription: string;
  latestVersion: string | null;
  latestCheckedAt: string | null;
  latestError: string | null;
  updatable: boolean;
  notUpdatableReason: string | null;
  updateAvailable: boolean;
  profiles: LocalProfileVersionSummary;
  updating: boolean;
  phase: BrowserChromeUpdatePhase;
  progress: { received: number; total: number } | null;
  error: string | null;
  lastUpdatedAt: string | null;
  closedSessions: number;
  deferredSessions: number;
}

export interface ChromeUpdaterOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** First launcher is the active engine's primary launcher; others are secondary launchers to reset in sync. */
  launchers: () => ChromeLauncher[];
  closeIdleSessions?: () => Promise<{ closed: number; active: number }>;
  onPreferDownloaded: () => void;
  onChange?: () => void;
  fetchLatest?: typeof fetchLatestChromeForTesting;
  installLatest?: typeof installLatestChromeForTesting;
  pruneOld?: typeof pruneOldChromeForTestingVersions;
  now?: () => number;
  cacheTtlMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function chromeUpdatability(
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv,
): { updatable: true; reason: null } | { updatable: false; reason: string } {
  if (env.OMB_BROWSER_LEGACY_SHELL?.trim() === "1") {
    return { updatable: false, reason: "OMB_BROWSER_LEGACY_SHELL=1 is set." };
  }
  if (env.OMB_CHROME_PATH?.trim() || env.AGENT_BROWSER_EXECUTABLE_PATH?.trim()) {
    return { updatable: false, reason: "Browser executable is pinned by environment variable." };
  }
  if (platform === "linux" && env.OMB_RESOURCES_PATH) {
    return { updatable: false, reason: "This Linux desktop build uses its bundled browser." };
  }
  if (!chromeForTestingPlatform(platform, arch)) {
    return { updatable: false, reason: `Chrome for Testing is not available for ${platform}-${arch}.` };
  }
  return { updatable: true, reason: null };
}

export class ChromeUpdater {
  readonly #options: ChromeUpdaterOptions;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #cacheTtlMs: number;

  #cachedRelease: ChromeForTestingRelease | null = null;
  #cachedAtMs = 0;
  #latestError: string | null = null;
  #checking: Promise<ChromeForTestingRelease | null> | null = null;

  #running: Promise<void> | null = null;
  #phase: BrowserChromeUpdatePhase = "idle";
  #progress: DownloadProgress | null = null;
  #error: string | null = null;
  #lastUpdatedAt: string | null = null;
  #closedSessions = 0;
  #deferredSessions = 0;

  constructor(options: ChromeUpdaterOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => Date.now());
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  snapshot(): BrowserChromeStatus {
    const launchers = this.#options.launchers();
    const primary = launchers[0];
    const info = primary ? primary.statusInfo() : { version: null, source: null, path: null, description: "Not started" };
    const profiles = scanLocalProfileChromeVersions(this.#options.dataDir, info.version);
    const ability = chromeUpdatability(this.#platform, this.#arch, this.#env);
    const latestVersion = this.#cachedRelease?.version ?? null;
    const versionBehind = Boolean(latestVersion && (!info.version || compareVersions(info.version, latestVersion) < 0));
    const profileMismatch = profiles.mismatchedCount > 0;
    const updateAvailable = ability.updatable && (versionBehind || profileMismatch);
    return {
      currentVersion: info.version,
      currentSource: info.source,
      currentDescription: info.description,
      latestVersion,
      latestCheckedAt: this.#cachedAtMs > 0 ? new Date(this.#cachedAtMs).toISOString() : null,
      latestError: this.#latestError,
      updatable: ability.updatable,
      notUpdatableReason: ability.reason,
      updateAvailable,
      profiles,
      updating: this.#running !== null,
      phase: this.#phase,
      progress: this.#progress ? { received: this.#progress.received, total: this.#progress.total } : null,
      error: this.#error,
      lastUpdatedAt: this.#lastUpdatedAt,
      closedSessions: this.#closedSessions,
      deferredSessions: this.#deferredSessions,
    };
  }

  async status(options: { forceCheck?: boolean } = {}): Promise<BrowserChromeStatus> {
    const ability = chromeUpdatability(this.#platform, this.#arch, this.#env);
    if (ability.updatable) {
      await this.#fetchLatestCached(options.forceCheck === true);
    }
    return this.snapshot();
  }

  startUpdate(): { started: true; status: BrowserChromeStatus } | { started: false; conflict?: string; status: BrowserChromeStatus } {
    const ability = chromeUpdatability(this.#platform, this.#arch, this.#env);
    if (!ability.updatable) {
      return { started: false, conflict: ability.reason, status: this.snapshot() };
    }
    if (this.#running) {
      return { started: false, status: this.snapshot() };
    }
    this.#phase = "checking";
    this.#progress = null;
    this.#error = null;
    this.#closedSessions = 0;
    this.#deferredSessions = 0;
    this.#running = this.#runUpdate().finally(() => {
      this.#running = null;
      this.#options.onChange?.();
    });
    this.#options.onChange?.();
    return { started: true, status: this.snapshot() };
  }

  /** Exposed for tests that await completion of an in-flight update. */
  whenIdle(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #fetchLatestCached(force: boolean): Promise<ChromeForTestingRelease | null> {
    const now = this.#now();
    if (!force && this.#cachedRelease && now - this.#cachedAtMs < this.#cacheTtlMs) {
      return this.#cachedRelease;
    }
    if (this.#checking) return this.#checking;
    let job!: Promise<ChromeForTestingRelease | null>;
    job = (async () => {
      try {
        const release = await (this.#options.fetchLatest ?? fetchLatestChromeForTesting)({
          platform: this.#platform,
          arch: this.#arch,
        });
        this.#cachedRelease = release;
        this.#cachedAtMs = this.#now();
        this.#latestError = null;
        return release;
      } catch (error) {
        this.#latestError = message(error);
        this.#options.log?.(`browser update: latest version check failed (${this.#latestError})`);
        return this.#cachedRelease;
      } finally {
        if (this.#checking === job) this.#checking = null;
      }
    })();
    this.#checking = job;
    return job;
  }

  async #runUpdate(): Promise<void> {
    try {
      this.#phase = "checking";
      const release = await (this.#options.fetchLatest ?? fetchLatestChromeForTesting)({
        platform: this.#platform,
        arch: this.#arch,
      });
      this.#cachedRelease = release;
      this.#cachedAtMs = this.#now();
      this.#latestError = null;

      this.#phase = "downloading";
      this.#progress = { received: 0, total: 0 };
      const executable = await (this.#options.installLatest ?? installLatestChromeForTesting)({
        dataDir: this.#options.dataDir,
        release,
        onStage: (stage) => {
          this.#phase = stage;
          if (stage === "extracting") this.#progress = null;
        },
        onProgress: (progress) => {
          if (this.#phase === "downloading") this.#progress = progress;
        },
      });

      const launchers = this.#options.launchers();
      const primary = launchers[0];
      if (!primary) throw new Error("No browser launcher is available.");

      this.#phase = "verifying";
      this.#progress = null;
      await primary.verifyBinary(executable);

      this.#phase = "switching";
      this.#options.onPreferDownloaded();
      for (const launcher of launchers) launcher.reset();
      await primary.prepare();
      for (const secondary of launchers.slice(1)) {
        if (secondary.plan().kind !== "legacy") void secondary.prepare();
      }

      if (this.#options.closeIdleSessions) {
        const sessions = await this.#options.closeIdleSessions();
        this.#closedSessions = sessions.closed;
        this.#deferredSessions = sessions.active;
      }

      if (this.#deferredSessions === 0) {
        (this.#options.pruneOld ?? pruneOldChromeForTestingVersions)(this.#options.dataDir, release.version, this.#options.log);
      }

      this.#phase = "done";
      this.#error = null;
      this.#lastUpdatedAt = new Date(this.#now()).toISOString();
    } catch (error) {
      this.#phase = "error";
      this.#progress = null;
      this.#error = message(error);
      this.#options.log?.(`browser update: failed (${this.#error})`);
    }
  }
}
