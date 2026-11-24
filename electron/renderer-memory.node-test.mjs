import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRendererHeapLimit,
  DEFAULT_MAX_OLD_SPACE_MB,
  formatRendererMemoryLine,
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

  it("logs on interval and clears its timer on stop", () => {
    const lines = [];
    let tick = null;
    let cleared = false;
    const monitor = startRendererMemoryMonitor({
      app: { getAppMetrics: () => [{ pid: 42, type: "Tab", memory: { workingSetSize: 512 * 1024 } }] },
      getMainWindow: () => null,
      log: (line) => lines.push(line),
      intervalMs: 1000,
      setTimer: (fn) => { tick = fn; return { unref() {} }; },
      clearTimer: () => { cleared = true; },
    });
    tick();
    assert.deepEqual(lines, ["[renderer-memory] pid=42 workingSet=512MB"]);
    monitor.stop();
    assert.equal(cleared, true);
  });
});
