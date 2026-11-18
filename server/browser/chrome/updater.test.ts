import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chromeForTestingExecutable, validateChromeForTestingDownloadUrl } from "./install.ts";
import type { ChromeLauncher } from "./launcher.ts";
import { ensureProfile, recordOpenedBy, scanLocalProfileChromeVersions } from "./profile.ts";
import { resolveChromePlan, type ChromeHost } from "./resolve.ts";
import { ChromeUpdater, chromeUpdatability } from "./updater.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-chrome-updater-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fakeLauncher(initial: { version: string | null; source: "installed" | "downloaded" | "named" | "agent-browser" | "legacy" | null }) {
  let state = { ...initial };
  const calls: string[] = [];
  const launcher = {
    statusInfo: () => ({
      version: state.version,
      source: state.source,
      path: state.version ? `/fake/chrome/${state.version}` : null,
      description: `Chrome ${state.version ?? "none"}`,
    }),
    plan: () => ({ kind: "chrome" as const, chrome: { path: "/fake/chrome", source: "downloaded" as const }, fallback: null }),
    verifyBinary: vi.fn(async () => {
      calls.push("verify");
      return "158.0.8127.36";
    }),
    reset: vi.fn(() => {
      calls.push("reset");
    }),
    prepare: vi.fn(async () => {
      calls.push("prepare");
      state = { version: "158.0.8127.36", source: "downloaded" };
    }),
  } as unknown as ChromeLauncher;
  return { launcher, calls };
}

describe("scanLocalProfileChromeVersions", () => {
  it("scans only local profiles and counts those newer than currentVersion", () => {
    const dataDir = makeTempDir();
    const p1 = ensureProfile(dataDir, "bot:alpha", { backend: "local" });
    recordOpenedBy(p1.dir, "158.0.8127.36");
    const p2 = ensureProfile(dataDir, "bot:beta", { backend: "local" });
    recordOpenedBy(p2.dir, "157.0.8103.51");
    const external = ensureProfile(dataDir, "mychrome:personal", { backend: "my-chrome" });
    recordOpenedBy(external.dir, "160.0.0.1");

    const summary = scanLocalProfileChromeVersions(dataDir, "157.0.8103.51");
    expect(summary).toEqual({ total: 2, maxVersion: "158.0.8127.36", mismatchedCount: 1 });
  });
});

describe("resolveChromePlan preferDownloaded", () => {
  it("prefers downloaded Chrome for Testing over installed Google Chrome when preferDownloaded is true", () => {
    const dataDir = "/data";
    const downloadedPath = chromeForTestingExecutable(dataDir, { version: "158.0.8127.36", platform: "mac-arm64" });
    const installedPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const host: ChromeHost = {
      platform: "darwin",
      arch: "arm64",
      env: {},
      dataDir,
      home: "/Users/test",
      exists: (p) => p === downloadedPath || p === installedPath,
      list: (dir) => (dir === "/data/tools/chrome" ? ["158.0.8127.36"] : []),
      registryValue: () => null,
      registryKeyExists: () => false,
      appForBundleId: () => null,
    };

    const defaultPlan = resolveChromePlan(host, { managed: true });
    expect(defaultPlan).toMatchObject({ kind: "chrome", chrome: { path: installedPath, source: "installed" } });

    const preferredPlan = resolveChromePlan(host, { managed: true }, { preferDownloaded: true });
    expect(preferredPlan).toMatchObject({ kind: "chrome", chrome: { path: downloadedPath, source: "downloaded" } });
  });
});

describe("validateChromeForTestingDownloadUrl", () => {
  it("accepts Google's exact CfT GCS URL and rejects unexpected hosts or paths", () => {
    expect(() => validateChromeForTestingDownloadUrl(
      "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
      "158.0.8127.36",
      "mac-arm64",
    )).not.toThrow();

    expect(() => validateChromeForTestingDownloadUrl(
      "https://evil.example/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
      "158.0.8127.36",
      "mac-arm64",
    )).toThrow(/unexpected Chrome download URL/i);
  });
});

describe("chromeUpdatability", () => {
  it("blocks updates when environment pins a browser or platform is unsupported", () => {
    expect(chromeUpdatability("darwin", "arm64", { OMB_CHROME_PATH: "/custom/chrome" }).updatable).toBe(false);
    expect(chromeUpdatability("darwin", "arm64", { OMB_BROWSER_LEGACY_SHELL: "1" }).updatable).toBe(false);
    expect(chromeUpdatability("linux", "x64", { OMB_RESOURCES_PATH: "/opt/omb/resources" }).updatable).toBe(false);
    expect(chromeUpdatability("freebsd" as NodeJS.Platform, "x64", {}).updatable).toBe(false);
    expect(chromeUpdatability("darwin", "arm64", {}).updatable).toBe(true);
  });
});

describe("ChromeUpdater", () => {
  it("caches latest version checks within TTL and refreshes when forced", async () => {
    const dataDir = makeTempDir();
    const { launcher } = fakeLauncher({ version: "157.0.8103.51", source: "installed" });
    let clock = 1_000_000;
    const fetchLatest = vi.fn(async () => ({
      version: "158.0.8127.36",
      platform: "mac-arm64",
      url: "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
    }));
    const updater = new ChromeUpdater({
      dataDir,
      platform: "darwin",
      arch: "arm64",
      env: {},
      launchers: () => [launcher],
      onPreferDownloaded: vi.fn(),
      fetchLatest,
      now: () => clock,
      cacheTtlMs: 60_000,
    });

    const first = await updater.status();
    expect(first.latestVersion).toBe("158.0.8127.36");
    expect(first.updateAvailable).toBe(true);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    clock += 10_000;
    await updater.status();
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    await updater.status({ forceCheck: true });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("downloads, verifies before switching, closes idle sessions, and prunes old CfT when no sessions are deferred", async () => {
    const dataDir = makeTempDir();
    const profile = ensureProfile(dataDir, "bot:alpha", { backend: "local" });
    recordOpenedBy(profile.dir, "158.0.8127.36");
    const oldDir = join(dataDir, "tools", "chrome", "153.0.8010.47");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "marker"), "old");

    const { launcher, calls } = fakeLauncher({ version: "157.0.8103.51", source: "installed" });
    const onPreferDownloaded = vi.fn(() => { calls.push("prefer"); });
    const pruneOld = vi.fn(() => {
      calls.push("prune");
      return ["153.0.8010.47"];
    });
    const updater = new ChromeUpdater({
      dataDir,
      platform: "darwin",
      arch: "arm64",
      env: {},
      launchers: () => [launcher],
      closeIdleSessions: async () => {
        calls.push("closeIdle");
        return { closed: 2, active: 0 };
      },
      onPreferDownloaded,
      fetchLatest: async () => ({
        version: "158.0.8127.36",
        platform: "mac-arm64",
        url: "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
      }),
      installLatest: async ({ onStage, onProgress }) => {
        calls.push("install");
        onStage?.("downloading");
        onProgress?.({ received: 50_000_000, total: 100_000_000 });
        onStage?.("extracting");
        return "/fake/chrome/158.0.8127.36";
      },
      pruneOld,
    });

    const start = updater.startUpdate();
    expect(start.started).toBe(true);
    await updater.whenIdle();

    expect(calls).toEqual(["install", "verify", "prefer", "reset", "prepare", "closeIdle", "prune"]);
    const after = updater.snapshot();
    expect(after.phase).toBe("done");
    expect(after.currentVersion).toBe("158.0.8127.36");
    expect(after.profiles.mismatchedCount).toBe(0);
    expect(after.closedSessions).toBe(2);
    expect(after.deferredSessions).toBe(0);
    expect(pruneOld).toHaveBeenCalledTimes(1);
  });

  it("defers pruning old CfT versions when active sessions remain running", async () => {
    const dataDir = makeTempDir();
    const { launcher } = fakeLauncher({ version: "157.0.8103.51", source: "installed" });
    const pruneOld = vi.fn(() => []);
    const updater = new ChromeUpdater({
      dataDir,
      platform: "darwin",
      arch: "arm64",
      env: {},
      launchers: () => [launcher],
      closeIdleSessions: async () => ({ closed: 1, active: 2 }),
      onPreferDownloaded: vi.fn(),
      fetchLatest: async () => ({
        version: "158.0.8127.36",
        platform: "mac-arm64",
        url: "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
      }),
      installLatest: async () => "/fake/chrome/158.0.8127.36",
      pruneOld,
    });

    updater.startUpdate();
    await updater.whenIdle();
    expect(updater.snapshot().deferredSessions).toBe(2);
    expect(pruneOld).not.toHaveBeenCalled();
  });

  it("does not mutate config or reset launchers when verification fails", async () => {
    const dataDir = makeTempDir();
    const { launcher } = fakeLauncher({ version: "157.0.8103.51", source: "installed" });
    vi.mocked(launcher.verifyBinary).mockRejectedValueOnce(new Error("broken binary"));
    const onPreferDownloaded = vi.fn();
    const updater = new ChromeUpdater({
      dataDir,
      platform: "darwin",
      arch: "arm64",
      env: {},
      launchers: () => [launcher],
      onPreferDownloaded,
      fetchLatest: async () => ({
        version: "158.0.8127.36",
        platform: "mac-arm64",
        url: "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip",
      }),
      installLatest: async () => "/fake/chrome/158.0.8127.36",
    });

    updater.startUpdate();
    await updater.whenIdle();
    expect(onPreferDownloaded).not.toHaveBeenCalled();
    expect(launcher.reset).not.toHaveBeenCalled();
    expect(updater.snapshot().phase).toBe("error");
    expect(updater.snapshot().error).toContain("broken binary");
  });
});
