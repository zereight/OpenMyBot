export const DEFAULT_MAX_OLD_SPACE_MB = 4096;
export const DEFAULT_MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MEMORY_WARN_MB = 2048;

export function applyRendererHeapLimit(commandLine, maxOldSpaceMb = DEFAULT_MAX_OLD_SPACE_MB) {
  if (!commandLine || typeof commandLine.appendSwitch !== "function") return false;
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
    privateMb: kbToMb(match.memory.privateBytes),
  };
}

export function formatRendererMemoryLine(sample, warnMb = DEFAULT_MEMORY_WARN_MB) {
  const level = sample.workingSetMb !== null && sample.workingSetMb >= warnMb
    ? "[renderer-memory][warn]"
    : "[renderer-memory]";
  const parts = [
    `pid=${sample.pid}`,
    sample.workingSetMb !== null ? `workingSet=${sample.workingSetMb}MB` : null,
    sample.peakWorkingSetMb !== null ? `peak=${sample.peakWorkingSetMb}MB` : null,
    sample.privateMb !== null ? `private=${sample.privateMb}MB` : null,
  ].filter(Boolean);
  return `${level} ${parts.join(" ")}`;
}

export function startRendererMemoryMonitor({
  app,
  getMainWindow,
  log = () => {},
  intervalMs = DEFAULT_MEMORY_LOG_INTERVAL_MS,
  warnMb = DEFAULT_MEMORY_WARN_MB,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let stopped = false;
  const sample = () => {
    if (stopped) return null;
    try {
      const reading = sampleRendererMemory({ app, getMainWindow });
      if (reading) log(formatRendererMemoryLine(reading, warnMb));
      return reading;
    } catch {
      return null;
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
