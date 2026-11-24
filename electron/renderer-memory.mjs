export const DEFAULT_MAX_OLD_SPACE_MB = 4096;
export const DEFAULT_MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MEMORY_WARN_MB = 2048;
export const DEFAULT_JS_HEAP_TIMEOUT_MS = 1500;

// Electron's MemoryInfo.privateBytes is @platform win32 only (undefined on macOS/Linux),
// so macOS logs omit `private=` and rely on `jsHeap` + `nonJsEst` to separate JS vs native growth.
const JS_HEAP_BYTES_EXPR = "typeof performance !== 'undefined' && performance.memory ? performance.memory.usedJSHeapSize : null";

export function applyRendererHeapLimit(commandLine, maxOldSpaceMb = DEFAULT_MAX_OLD_SPACE_MB) {
  if (!commandLine || typeof commandLine.appendSwitch !== "function") return false;
  // Without this switch Chromium buckets/caches performance.memory.usedJSHeapSize for ~20 min,
  // making jsHeap stale and causing nonJsEst to misattribute JS growth to native memory.
  commandLine.appendSwitch("enable-precise-memory-info");
  const existing = typeof commandLine.getSwitchValue === "function"
    ? (commandLine.getSwitchValue("js-flags") ?? "").trim()
    : "";
  if (/(?:^|\s)--max-old-space-size(?:=|\s)/.test(existing)) return false;
  const flag = `--max-old-space-size=${maxOldSpaceMb}`;
  commandLine.appendSwitch("js-flags", existing ? `${existing} ${flag}` : flag);
  return true;
}

function kbToMb(kb) {
  return typeof kb === "number" && Number.isFinite(kb) ? Math.round((kb / 1024) * 10) / 10 : null;
}

function bytesToMb(bytes) {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0
    ? Math.round((bytes / (1024 * 1024)) * 10) / 10
    : null;
}

export function sampleRendererMemory({ app, getMainWindow }) {
  if (!app || typeof app.getAppMetrics !== "function") return null;
  const win = getMainWindow?.();
  const contents = win && !win.isDestroyed?.() ? win.webContents : null;
  const pid = contents && !contents.isDestroyed?.() && !contents.isCrashed?.()
    ? contents.getOSProcessId?.()
    : null;
  const metrics = app.getAppMetrics();
  if (!Array.isArray(metrics) || metrics.length === 0) return null;
  const match = (typeof pid === "number" && pid > 0
    ? metrics.find((entry) => entry?.pid === pid)
    : null) ?? metrics.find((entry) => entry?.type === "Tab");
  if (!match?.memory) return null;
  return {
    pid: match.pid ?? pid ?? 0,
    workingSetMb: kbToMb(match.memory.workingSetSize),
    peakWorkingSetMb: kbToMb(match.memory.peakWorkingSetSize),
    // Populated on Windows only (@platform win32 in Electron MemoryInfo); null on macOS/Linux.
    privateMb: kbToMb(match.memory.privateBytes),
  };
}

export async function sampleRendererJsHeapMb({ getMainWindow, timeoutMs = DEFAULT_JS_HEAP_TIMEOUT_MS } = {}) {
  const win = getMainWindow?.();
  const contents = win && !win.isDestroyed?.() ? win.webContents : null;
  if (!contents || contents.isDestroyed?.() || contents.isCrashed?.() || typeof contents.executeJavaScript !== "function") {
    return null;
  }
  let timer = null;
  try {
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer?.unref?.();
    });
    const bytes = await Promise.race([
      Promise.resolve().then(() => contents.executeJavaScript(JS_HEAP_BYTES_EXPR)),
      timeoutPromise,
    ]);
    return bytesToMb(bytes);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatRendererMemoryLine(sample, warnMb = DEFAULT_MEMORY_WARN_MB) {
  const level = sample.workingSetMb !== null && sample.workingSetMb >= warnMb
    ? "[renderer-memory][warn]"
    : "[renderer-memory]";
  const jsHeapMb = sample.jsHeapMb ?? null;
  const nonJsEstMb = sample.workingSetMb !== null && jsHeapMb !== null
    ? Math.max(0, Math.round((sample.workingSetMb - jsHeapMb) * 10) / 10)
    : null;
  const parts = [
    `pid=${sample.pid}`,
    sample.workingSetMb !== null ? `workingSet=${sample.workingSetMb}MB` : null,
    sample.peakWorkingSetMb !== null ? `peak=${sample.peakWorkingSetMb}MB` : null,
    sample.privateMb !== null ? `private=${sample.privateMb}MB` : null,
    jsHeapMb !== null ? `jsHeap=${jsHeapMb}MB` : null,
    nonJsEstMb !== null ? `nonJsEst=${nonJsEstMb}MB` : null,
  ].filter(Boolean);
  return `${level} ${parts.join(" ")}`;
}

export function startRendererMemoryMonitor({
  app,
  getMainWindow,
  log = () => {},
  intervalMs = DEFAULT_MEMORY_LOG_INTERVAL_MS,
  warnMb = DEFAULT_MEMORY_WARN_MB,
  jsHeapTimeoutMs = DEFAULT_JS_HEAP_TIMEOUT_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let stopped = false;
  let inFlight = false;
  const sample = async () => {
    if (stopped || inFlight) return null;
    inFlight = true;
    try {
      const base = sampleRendererMemory({ app, getMainWindow });
      if (!base) return null;
      const jsHeapMb = await sampleRendererJsHeapMb({ getMainWindow, timeoutMs: jsHeapTimeoutMs });
      if (stopped) return null;
      const reading = { ...base, jsHeapMb };
      log(formatRendererMemoryLine(reading, warnMb));
      return reading;
    } catch {
      return null;
    } finally {
      inFlight = false;
    }
  };
  const timer = setTimer(sample, intervalMs);
  timer?.unref?.();
  return {
    sample,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
    },
  };
}

export function notifyRendererOom({ app, Notification, log = () => {}, count = 1 }) {
  log(`[renderer-memory] renderer hit memory limit (oom #${count}); reloading window`);
  if (Notification?.isSupported?.()) {
    try { new Notification({ title: app?.name ?? "OpenMyBot", body: "Reloaded the window after reaching its memory limit." }).show(); } catch {}
  }
}
