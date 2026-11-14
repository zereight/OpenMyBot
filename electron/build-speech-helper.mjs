// A real app bundle: macOS TCC reads the executable's bundle Info.plist and kills a loose binary that lacks one.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");

export const speechHelperBundle = path.join(resourcesDir, "OpenMausBot Speech.app");
export const speechHelperBinary = path.join(speechHelperBundle, "Contents", "MacOS", "speech-helper");
export const speechHelperEntitlements = path.join(projectDir, "build", "entitlements.mac.plist");
/** Inputs besides the Swift source and Info.plist that change what a built helper looks like. */
export const speechHelperBuildInputs = [fileURLToPath(import.meta.url), speechHelperEntitlements];

// Apple's tools by absolute path: a swiftly/swift.org `swiftc` first on PATH is too old for the Xcode SDK's modules.
const XCRUN = "/usr/bin/xcrun";
const LIPO = "/usr/bin/lipo";
const CODESIGN = "/usr/bin/codesign";

// `TOOLCHAINS` makes even xcrun pick a swift.org toolchain, so it is dropped; DEVELOPER_DIR and xcode-select still apply.
function toolEnv() {
  const { TOOLCHAINS: _toolchains, ...env } = process.env;
  return env;
}

export function buildSpeechHelper({ bundle = speechHelperBundle, entitlements = speechHelperEntitlements } = {}) {
  const contents = path.join(bundle, "Contents");
  const binary = path.join(contents, "MacOS", "speech-helper");
  const env = toolEnv();
  const slices = ["arm64", "x86_64"].map((arch) => `${binary}-${arch}`);
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "speech-helper-Info.plist"), path.join(contents, "Info.plist"));
  try {
    // Universal, since the helper rides in both arm64 and x64 apps and bare `swiftc` builds host-arch only. macos12 = LSMinimumSystemVersion.
    for (const [index, arch] of ["arm64", "x86_64"].entries()) {
      execFileSync(
        XCRUN,
        ["swiftc", "-O", "-target", `${arch}-apple-macos12`, path.join(resourcesDir, "speech-helper.swift"), "-o", slices[index]],
        { stdio: "inherit", timeout: 120_000, env },
      );
    }
    execFileSync(LIPO, ["-create", ...slices, "-output", binary], { stdio: "inherit", timeout: 60_000, env });
    // Before signing: the seal covers every file in the bundle, so a slice deleted afterwards breaks it.
    for (const slice of slices) rmSync(slice, { force: true });
    const archs = execFileSync(LIPO, ["-archs", binary], { timeout: 60_000, env }).toString();
    if (!archs.includes("arm64") || !archs.includes("x86_64")) {
      throw new Error(`speech helper is not universal: ${archs.trim()}`);
    }
    // Ad-hoc signed for dev with the release's audio entitlement; electron-builder replaces it when signing.
    execFileSync(
      CODESIGN,
      ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, bundle],
      { stdio: "inherit", timeout: 30_000, env },
    );
  } catch (error) {
    // A half-built helper (lipo's output, never sealed with the entitlements) must not look up to date next time.
    rmSync(binary, { force: true });
    throw error;
  } finally {
    // A failed arch build or lipo leaves slices behind.
    for (const slice of slices) rmSync(slice, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSpeechHelper();
}
