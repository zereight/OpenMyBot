import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSpeechHelper, speechHelperBuildInputs, speechHelperEntitlements } from "./build-speech-helper.mjs";

const canBuild = process.platform === "darwin" && spawnSync("/usr/bin/xcrun", ["--find", "swiftc"]).status === 0;
const skip = !canBuild && "needs macOS with Xcode's swiftc";

// Builds into a scratch bundle, so a developer's real electron/resources helper is never touched.
function scratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "build-speech-helper-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const marker = join(dir, "fake-swiftc-ran");
  // An older swiftc (swiftly, swift.org) first on PATH: the build used to pick it up and fail on the Xcode SDK.
  const fake = join(bin, "swiftc");
  writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\necho "fake swiftc" >&2\nexit 1\n`);
  chmodSync(fake, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return run({ bundle: join(dir, "OpenMausBot Speech.app"), marker });
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the helper builds with Apple's toolchain even when another swiftc comes first on PATH", { skip }, () => {
  scratch(({ bundle, marker }) => {
    buildSpeechHelper({ bundle });
    const binary = join(bundle, "Contents", "MacOS", "speech-helper");
    const archs = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" });
    assert.match(archs, /arm64/);
    assert.match(archs, /x86_64/);
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    assert.equal(existsSync(marker), false, "the PATH swiftc must not be used");
    assert.deepEqual(readdirSync(join(bundle, "Contents", "MacOS")), ["speech-helper"]);
  });
});

test("a failed build leaves no helper binary behind to be mistaken for a finished one", { skip }, () => {
  scratch(({ bundle }) => {
    // A missing entitlements file makes the real codesign step fail after lipo has written the binary.
    assert.throws(() => buildSpeechHelper({ bundle, entitlements: join(bundle, "missing.plist") }));
    assert.deepEqual(readdirSync(join(bundle, "Contents", "MacOS")), []);
  });
});

test("a changed build script or entitlements file makes a built helper stale", () => {
  assert.ok(speechHelperBuildInputs.includes(speechHelperEntitlements));
  assert.ok(speechHelperBuildInputs.some((file) => file.endsWith("build-speech-helper.mjs")));
});
