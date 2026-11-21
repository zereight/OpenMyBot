// Chrome for Testing's full browser, never its headless shell: a download is pinned by size and SHA-256 per platform, checked
// before it is unpacked, and unpacked beside its final folder so a reader only ever sees a complete browser.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";

import { renameWithRetry } from "../../atomic.ts";

export const CHROME_FOR_TESTING_VERSION = "153.0.8010.47";
export const CHROME_FOR_TESTING_VERSION_RE = /^\d+(?:\.\d+){1,3}$/;
export const CHROME_FOR_TESTING_API_URL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

export interface ChromeForTestingPin {
  version: string;
  /** Chrome for Testing's own platform name, as in its download URLs. */
  platform: string;
  bytes: number;
  sha256: string;
}

export interface ChromeForTestingRelease {
  version: string;
  platform: string;
  url: string;
}

const PLATFORMS: Record<string, string> = {
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
  "win32-x64": "win64",
  "linux-x64": "linux64",
  "linux-arm64": "linux-arm64",
};

/** A platform without a SHA-256 here downloads nothing; scripts/pin-chrome-for-testing.ts measures new pins. */
const PINS: Record<string, Omit<ChromeForTestingPin, "version">> = {
  "darwin-arm64": { platform: "mac-arm64", bytes: 190878359, sha256: "939ef9dc3aa74240c929d793e123edab0fda89c5a9cfeb029686c34141d2ed58" },
  "linux-x64": { platform: "linux64", bytes: 195709628, sha256: "89778cbf7a852726b6f51649b2586b894c00737e81f8031733721560d21bbea7" },
  "linux-arm64": { platform: "linux-arm64", bytes: 195919275, sha256: "ef3d2fea85e675ba8e9a7894c0be4595e5130659a9ac95e04c6064ed09f411da" },
};

const EXECUTABLES: Record<string, string> = {
  "mac-arm64": "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "mac-x64": "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  win64: "chrome-win64/chrome.exe",
  linux64: "chrome-linux64/chrome",
  "linux-arm64": "chrome-linux-arm64/chrome",
};

const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const METADATA_TIMEOUT_MS = 15_000;
const MAX_UNPINNED_ARCHIVE_BYTES = 500 * 1024 * 1024;

export function chromeForTestingPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  return PLATFORMS[`${platform}-${arch}`] ?? null;
}

export function chromeForTestingPin(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ChromeForTestingPin | null {
  const pin = PINS[`${platform}-${arch}`];
  return pin ? { version: CHROME_FOR_TESTING_VERSION, ...pin } : null;
}

export function chromeForTestingUrl(pin: Pick<ChromeForTestingPin, "version" | "platform">): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${pin.version}/${pin.platform}/chrome-${pin.platform}.zip`;
}

/** Rejects any download URL that does not match Google's exact Chrome for Testing bucket layout. */
export function validateChromeForTestingDownloadUrl(url: string, version: string, platform: string): void {
  if (!CHROME_FOR_TESTING_VERSION_RE.test(version)) throw new Error(`Invalid Chrome for Testing version: ${version}`);
  if (!EXECUTABLES[platform]) throw new Error(`Unsupported Chrome for Testing platform: ${platform}`);
  const expected = chromeForTestingUrl({ version, platform });
  if (url !== expected) throw new Error(`Refusing unexpected Chrome download URL: ${url}`);
}

export async function fetchLatestChromeForTesting(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<ChromeForTestingRelease> {
  const cftPlatform = chromeForTestingPlatform(options.platform, options.arch);
  if (!cftPlatform) throw new Error(`Chrome for Testing is not available for ${options.platform ?? process.platform}-${options.arch ?? process.arch}.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? METADATA_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(CHROME_FOR_TESTING_API_URL, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`Could not check the latest Chrome version (HTTP ${response.status}).`);
    const payload = await response.json() as {
      channels?: { Stable?: { version?: unknown; downloads?: { chrome?: Array<{ platform?: unknown; url?: unknown }> } } };
    };
    const stable = payload?.channels?.Stable;
    const version = typeof stable?.version === "string" ? stable.version.trim() : "";
    const entry = stable?.downloads?.chrome?.find((item) => item?.platform === cftPlatform);
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (!version || !url) throw new Error(`No Stable Chrome for Testing build was listed for ${cftPlatform}.`);
    validateChromeForTestingDownloadUrl(url, version, cftPlatform);
    return { version, platform: cftPlatform, url };
  } finally {
    clearTimeout(timer);
  }
}

export function chromeForTestingDirectory(dataDir: string, pin: Pick<ChromeForTestingPin, "version" | "platform">): string {
  return join(dataDir, "tools", "chrome", pin.version, pin.platform);
}

export function chromeForTestingExecutable(dataDir: string, pin: Pick<ChromeForTestingPin, "version" | "platform">): string {
  const relative = EXECUTABLES[pin.platform];
  if (!relative) throw new Error(`Chrome for Testing has no known layout for ${pin.platform}.`);
  return join(chromeForTestingDirectory(dataDir, pin), relative);
}

export interface DownloadProgress { received: number; total: number }

/** Streams to `destination`, hashing on the way; a body longer than `bytes` is cut off. Resolves to the SHA-256 it read. */
export async function downloadArchive(
  url: string,
  destination: string,
  bytes: number,
  options: { fetchImpl?: typeof fetch; onProgress?: (progress: DownloadProgress) => void; timeoutMs?: number; label?: string } = {},
): Promise<string> {
  const what = options.label ?? "Chrome";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  const hash = createHash("sha256");
  let received = 0;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: "follow", signal: controller.signal });
    const body = response.body;
    if (!response.ok || !body) throw new Error(`the ${what} download failed (HTTP ${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared !== bytes) throw new Error(`the ${what} download did not match its pinned size; nothing was installed`);
    const file = createWriteStream(destination, { mode: 0o600 });
    file.once("error", () => controller.abort());
    await pipeline(async function* () {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > bytes) throw new Error(`the ${what} download was larger than its pinned size; nothing was installed`);
        hash.update(chunk);
        yield chunk;
        options.onProgress?.({ received, total: bytes });
      }
    }, file);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (received !== bytes) throw new Error(`the ${what} download ended early; nothing was installed`);
  return hash.digest("hex");
}

export type Extract = (archive: string, directory: string) => Promise<void>;

/** Git Bash puts GNU tar, which cannot read a zip, ahead of Windows' own bsdtar on PATH; name System32's. */
export const extractZip: Extract = (archive, directory) => new Promise((resolve, reject) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const [file, args] = process.platform === "win32"
    ? [win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", directory]]
    : ["unzip", ["-q", archive, "-d", directory]];
  execFile(file, args, { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error) => {
    if (error) {
      const noUnzip = file === "unzip" && (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(new Error(noUnzip ? "the Chrome archive could not be unpacked: check that unzip is installed and on the server's PATH (Debian/Ubuntu: sudo apt-get install unzip)" : `the Chrome archive could not be unpacked: ${error.message}`));
    }
    else resolve();
  });
});

const installs = new Map<string, Promise<string>>();

/** One download per folder at a time; resolves to the browser executable. */
export function installChromeForTesting(options: {
  dataDir: string;
  pin: ChromeForTestingPin;
  fetchImpl?: typeof fetch;
  extract?: Extract;
  onProgress?: (progress: DownloadProgress) => void;
  url?: string;
}): Promise<string> {
  const directory = chromeForTestingDirectory(options.dataDir, options.pin);
  let running = installs.get(directory);
  if (!running) {
    running = install(options).finally(() => installs.delete(directory));
    installs.set(directory, running);
  }
  return running;
}

async function install(options: Parameters<typeof installChromeForTesting>[0]): Promise<string> {
  const { dataDir, pin } = options;
  const executable = chromeForTestingExecutable(dataDir, pin);
  if (existsSync(executable)) return executable;
  const directory = chromeForTestingDirectory(dataDir, pin);
  const root = dirname(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Only what an interrupted install left: a download still running elsewhere keeps writing, so its files stay recent.
  for (const name of readdirSync(root)) {
    const part = join(root, name);
    if (name.endsWith(".part") && Date.now() - statSync(part).mtimeMs > DOWNLOAD_TIMEOUT_MS) rmSync(part, { recursive: true, force: true });
  }
  const tag = randomBytes(6).toString("hex");
  const archive = join(root, `${pin.platform}.${tag}.zip.part`);
  const staging = join(root, `${pin.platform}.${tag}.part`);
  try {
    const digest = await downloadArchive(options.url ?? chromeForTestingUrl(pin), archive, pin.bytes, options);
    if (digest !== pin.sha256) throw new Error("the Chrome download failed its SHA-256 check; nothing was installed");
    await (options.extract ?? extractZip)(archive, staging);
    if (!existsSync(join(staging, EXECUTABLES[pin.platform]!))) throw new Error("the Chrome archive did not hold the browser; nothing was installed");
    rmSync(directory, { recursive: true, force: true });
    renameWithRetry(staging, directory);
    return executable;
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

export function parseGcsMd5Header(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("md5=")) {
      const value = trimmed.slice(4).trim();
      if (value) return value;
    }
  }
  return null;
}

/** Rejects Zip Slip paths (`..`, absolute paths, drive letters, NUL bytes) before extraction runs. */
export function verifyZipEntriesSafe(archivePath: string): void {
  const size = statSync(archivePath).size;
  const tailSize = Math.min(size, 65_557);
  if (tailSize < 22) throw new Error("the Chrome archive is not a valid ZIP file; nothing was installed");
  const fd = openSync(archivePath, "r");
  try {
    const tail = Buffer.alloc(tailSize);
    readSync(fd, tail, 0, tailSize, size - tailSize);
    let eocdOffset = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("the Chrome archive is missing its ZIP directory; nothing was installed");
    let cdSize = tail.readUInt32LE(eocdOffset + 12);
    let cdOffset = tail.readUInt32LE(eocdOffset + 16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorOffset = eocdOffset - 20;
      if (locatorOffset < 0 || tail.readUInt32LE(locatorOffset) !== 0x07064b50) {
        throw new Error("the Chrome archive has an invalid ZIP64 locator; nothing was installed");
      }
      const zip64EocdOffset = Number(tail.readBigUInt64LE(locatorOffset + 8));
      const zip64 = Buffer.alloc(56);
      readSync(fd, zip64, 0, 56, zip64EocdOffset);
      if (zip64.readUInt32LE(0) !== 0x06064b50) {
        throw new Error("the Chrome archive has an invalid ZIP64 directory; nothing was installed");
      }
      cdSize = Number(zip64.readBigUInt64LE(40));
      cdOffset = Number(zip64.readBigUInt64LE(48));
    }
    if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > size) {
      throw new Error("the Chrome archive has an out-of-bounds ZIP directory; nothing was installed");
    }
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    let pos = 0;
    while (pos < cd.length) {
      if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) {
        throw new Error("the Chrome archive has a corrupted ZIP entry; nothing was installed");
      }
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const nameEnd = pos + 46 + nameLen;
      if (nameEnd > cd.length) throw new Error("the Chrome archive has a truncated ZIP entry; nothing was installed");
      const name = cd.subarray(pos + 46, nameEnd).toString("utf8");
      if (
        name.includes("\0")
        || name.startsWith("/")
        || name.startsWith("\\")
        || /^[A-Za-z]:/.test(name)
        || name.split(/[\\/]/).some((segment) => segment === "..")
      ) {
        throw new Error(`the Chrome archive contained an unsafe path (${name.slice(0, 80)}); nothing was installed`);
      }
      pos = nameEnd + extraLen + commentLen;
    }
  } finally {
    closeSync(fd);
  }
}

/** Ensures symlinks inside an unpacked bundle (such as macOS .app frameworks) stay inside the staging directory. */
export function verifyNoEscapingSymlinks(stagingDir: string): void {
  const rootReal = realpathSync(stagingDir);
  const stack = [rootReal];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = resolvePath(dir, readlinkSync(full));
        if (target !== rootReal && !target.startsWith(`${rootReal}${sep}`)) {
          throw new Error("the Chrome archive contained a symlink escaping its folder; nothing was installed");
        }
      } else if (stat.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

export async function downloadUnpinnedArchive(
  url: string,
  destination: string,
  options: { fetchImpl?: typeof fetch; onProgress?: (progress: DownloadProgress) => void; timeoutMs?: number; maxBytes?: number } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_UNPINNED_ARCHIVE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  const md5 = createHash("md5");
  let received = 0;
  let declared = NaN;
  let expectedMd5: string | null = null;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: "error", signal: controller.signal });
    const body = response.body;
    if (!response.ok || !body) throw new Error(`the Chrome download failed (HTTP ${response.status})`);
    declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
      throw new Error("the Chrome download size was outside the allowed range; nothing was installed");
    }
    expectedMd5 = parseGcsMd5Header(response.headers.get("x-goog-hash"));
    const total = Number.isFinite(declared) ? declared : 0;
    const file = createWriteStream(destination, { mode: 0o600 });
    file.once("error", () => controller.abort());
    await pipeline(async function* () {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new Error("the Chrome download exceeded the maximum allowed size; nothing was installed");
        if (expectedMd5) md5.update(chunk);
        yield chunk;
        options.onProgress?.({ received, total });
      }
    }, file);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (Number.isFinite(declared) && received !== declared) {
    throw new Error("the Chrome download ended early; nothing was installed");
  }
  if (expectedMd5 && md5.digest("base64") !== expectedMd5) {
    throw new Error("the Chrome download failed its integrity check; nothing was installed");
  }
}

/** Explicit admin-triggered Chrome for Testing update: validates the GCS URL, enforces no redirects, checks ZIP paths and symlinks. */
export function installLatestChromeForTesting(options: {
  dataDir: string;
  release: ChromeForTestingRelease;
  fetchImpl?: typeof fetch;
  extract?: Extract;
  onProgress?: (progress: DownloadProgress) => void;
  onStage?: (stage: "downloading" | "extracting") => void;
}): Promise<string> {
  validateChromeForTestingDownloadUrl(options.release.url, options.release.version, options.release.platform);
  const directory = chromeForTestingDirectory(options.dataDir, options.release);
  let running = installs.get(directory);
  if (!running) {
    running = installRelease(options).finally(() => installs.delete(directory));
    installs.set(directory, running);
  }
  return running;
}

async function installRelease(options: Parameters<typeof installLatestChromeForTesting>[0]): Promise<string> {
  const { dataDir, release } = options;
  const executable = chromeForTestingExecutable(dataDir, release);
  if (existsSync(executable)) return executable;
  const directory = chromeForTestingDirectory(dataDir, release);
  const root = dirname(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tag = randomBytes(6).toString("hex");
  const archive = join(root, `${release.platform}.${tag}.zip.part`);
  const staging = join(root, `${release.platform}.${tag}.part`);
  try {
    options.onStage?.("downloading");
    await downloadUnpinnedArchive(release.url, archive, options);
    verifyZipEntriesSafe(archive);
    options.onStage?.("extracting");
    await (options.extract ?? extractZip)(archive, staging);
    verifyNoEscapingSymlinks(staging);
    if (!existsSync(join(staging, EXECUTABLES[release.platform]!))) {
      throw new Error("the Chrome archive did not hold the browser; nothing was installed");
    }
    rmSync(directory, { recursive: true, force: true });
    renameWithRetry(staging, directory);
    return executable;
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Removes older Chrome for Testing version folders under `<dataDir>/tools/chrome` after a verified switch. */
export function pruneOldChromeForTestingVersions(dataDir: string, keepVersion: string, log?: (line: string) => void): string[] {
  const root = join(dataDir, "tools", "chrome");
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === keepVersion || !CHROME_FOR_TESTING_VERSION_RE.test(name)) continue;
    const target = join(root, name);
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(name);
    } catch (error) {
      log?.(`browser: could not remove old Chrome ${name} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return removed;
}
