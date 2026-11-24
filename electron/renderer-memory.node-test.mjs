import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRendererHeapLimit,
  DEFAULT_MAX_OLD_SPACE_MB,
  formatRendererMemoryLine,
  sampleRendererJsHeapMb,
  sampleRendererMemory,
  startRendererMemoryMonitor,
} from "./renderer-memory.mjs";

describe("applyRendererHeapLimit", () => {
  it("sets --max-old-space-size=4096 when js-flags is absent", () => {
    const switches = new Map();
    const commandLine = {
      getSwitchValue: (name) => switches.get(name) ?? "",
      appendSwitch: (name, value) => switches.set(name, value),
    };
    assert.equal(applyRendererHeapLimit(commandLine), true);
    assert.equal(switches.get("js-flags"), `--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_MB}`);
    assert.equal(switches.has("enable-precise-memory-info"), true);
  });

  it("preserves existing js-flags when appending max-old-space-size", () => {
    const switches = new Map([["js-flags", "--expose-gc"]]);
    const commandLine = {
      getSwitchValue: (name) => switches.get(name) ?? "",
      appendSwitch: (name, value) => switches.set(name, value),
    };
    assert.equal(applyRendererHeapLimit(commandLine, 4096), true);
    assert.equal(switches.get("js-flags"), "--expose-gc --max-old-space-size=4096");
  });

  it("does not overwrite an explicit --max-old-space-size flag", () => {
    const switches = new Map([["js-flags", "--max-old-space-size=2048"]]);
    const commandLine = {
      getSwitchValue: (name) => switches.get(name) ?? "",
      appendSwitch: (name, value) => switches.set(name, value),
    };
    assert.equal(applyRendererHeapLimit(commandLine, 4096), false);
    assert.equal(switches.get("js-flags"), "--max-old-space-size=2048");
  });
});

describe("renderer memory monitor", () => {
  it("samples the main window renderer PID and flags readings above warnMb", () => {
    const app = {
      getAppMetrics: () => [
        { pid: 100, type: "Browser", memory: { workingSetSize: 102400 } },
        { pid: 200, type: "Tab", memory: { workingSetSize: 2_621_440, peakWorkingSetSize: 3_145_728, privateBytes: 2_097_152 } },
      ],
    };
    const reading = sampleRendererMemory({
      app,
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, isCrashed: () => false, getOSProcessId: () => 200 },
      }),
    });
    assert.deepEqual(reading, { pid: 200, workingSetMb: 2560, peakWorkingSetMb: 3072, privateMb: 2048 });
    assert.equal(
      formatRendererMemoryLine(reading, 2048),
      "[renderer-memory][warn] pid=200 workingSet=2560MB peak=3072MB private=2048MB",
    );
  });

  it("omits win32-only private= on macOS and includes jsHeap + nonJsEst when available", () => {
    const line = formatRendererMemoryLine(
      { pid: 55198, workingSetMb: 499.2, peakWorkingSetMb: 571.8, privateMb: null, jsHeapMb: 62.4 },
      2048,
    );
    assert.equal(
      line,
      "[renderer-memory] pid=55198 workingSet=499.2MB peak=571.8MB jsHeap=62.4MB nonJsEst=436.8MB",
    );
  });

  it("reads JS heap via executeJavaScript and falls back to null on timeout", async () => {
    const okMb = await sampleRendererJsHeapMb({
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, isCrashed: () => false, executeJavaScript: async () => 65_431_142 },
      }),
    });
    assert.equal(okMb, 62.4);

    const timedOutMb = await sampleRendererJsHeapMb({
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, isCrashed: () => false, executeJavaScript: () => new Promise(() => {}) },
      }),
      timeoutMs: 20,
    });
    assert.equal(timedOutMb, null);
  });

  it("logs on interval and clears its timer on stop", async () => {
    const lines = [];
    let tick = null;
    let cleared = false;
    const monitor = startRendererMemoryMonitor({
      app: { getAppMetrics: () => [{ pid: 42, type: "Tab", memory: { workingSetSize: 512 * 1024 } }] },
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, isCrashed: () => false, getOSProcessId: () => 42, executeJavaScript: async () => 64 * 1024 * 1024 },
      }),
      log: (line) => lines.push(line),
      intervalMs: 1000,
      setTimer: (fn) => { tick = fn; return { unref() {} }; },
      clearTimer: () => { cleared = true; },
    });
    await tick();
    assert.deepEqual(lines, ["[renderer-memory] pid=42 workingSet=512MB jsHeap=64MB nonJsEst=448MB"]);
    monitor.stop();
    assert.equal(cleared, true);
  });
});
