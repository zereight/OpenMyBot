export const DEFAULT_MAX_CRASHES = 3;
export const DEFAULT_CRASH_WINDOW_MS = 60_000;
export const DEFAULT_STABLE_RESET_MS = 15_000;
export const DEFAULT_RESUME_DELAY_MS = 800;

export function isLiveWebContents(contents) {
  if (!contents) return false;
  if (contents.isDestroyed?.()) return false;
  if (contents.isCrashed?.()) return false;
  if ("mainFrame" in contents && !contents.mainFrame) return false;
  return true;
}

export function safeSend(contents, channel, ...args) {
  if (!isLiveWebContents(contents)) return false;
  try {
    contents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(raw) {
  return typeof raw === "string" && /^https?:\/\//i.test(raw);
}

function isAbortedLoad(error) {
  return error?.code === "ERR_ABORTED" || error?.errno === -3;
}

export function resolveRecoveryTarget({
  currentUrl = "",
  activeOrigin = null,
  localOrigin = "",
  isRemote = false,
  serverReady = true,
  isPackaged = false,
  desktopRemoteAccess = false,
  devUrl = "",
  homeActive = false,
  buildErrorPage = () => "",
}) {
  if (homeActive) return { kind: "home" };
  if (!isRemote && (desktopRemoteAccess || isPackaged) && !serverReady) {
    return { kind: "load", url: buildErrorPage() };
  }
  const allowedOrigin = isRemote ? activeOrigin : localOrigin;
  if (isHttpUrl(currentUrl) && allowedOrigin) {
    try {
      const parsed = new URL(currentUrl);
      if (parsed.origin === allowedOrigin && parsed.pathname !== "/pair") {
        return { kind: "load", url: currentUrl };
      }
    } catch {}
  }
  const fallback = isRemote
    ? activeOrigin
    : (desktopRemoteAccess || isPackaged ? localOrigin : devUrl);
  return { kind: "load", url: fallback || localOrigin || devUrl };
}

export function attachRendererRecovery(win, {
  powerMonitor = null,
  resolveTarget,
  recoverHome = () => Promise.resolve(),
  isQuitting = () => false,
  onCircuitOpen = null,
  log = () => {},
  maxCrashes = DEFAULT_MAX_CRASHES,
  windowMs = DEFAULT_CRASH_WINDOW_MS,
  stableMs = DEFAULT_STABLE_RESET_MS,
  resumeDelayMs = DEFAULT_RESUME_DELAY_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const contents = win.webContents;
  let suspended = false;
  let pendingRecovery = false;
  let recovering = false;
  let tripped = false;
  let disposed = false;
  let stableTimer = null;
  let resumeTimer = null;
  const crashTimestamps = [];

  const stopStableTimer = () => {
    if (stableTimer !== null) {
      clearTimer(stableTimer);
      stableTimer = null;
    }
  };

  const stopResumeTimer = () => {
    if (resumeTimer !== null) {
      clearTimer(resumeTimer);
      resumeTimer = null;
    }
  };

  const attemptRecovery = async (trigger) => {
    if (disposed || win.isDestroyed() || isQuitting() || recovering || tripped) return false;
    pendingRecovery = false;
    stopResumeTimer();
    recovering = true;
    try {
      const target = resolveTarget();
      if (target?.kind === "home") {
        log(`renderer recovery (${trigger}): reloading home view`);
        await Promise.resolve(recoverHome());
      } else if (target?.url) {
        log(`renderer recovery (${trigger}): reloading ${target.url}`);
        await Promise.resolve(win.loadURL(target.url));
      }
      return true;
    } catch (error) {
      if (!isAbortedLoad(error)) {
        log(`renderer recovery (${trigger}) failed: ${error?.message ?? error}`);
      }
      return false;
    } finally {
      recovering = false;
    }
  };

  const scheduleResumeRecovery = (trigger) => {
    if (disposed || !pendingRecovery || tripped || recovering || resumeTimer !== null) return;
    resumeTimer = setTimer(() => {
      resumeTimer = null;
      if (!suspended && pendingRecovery) void attemptRecovery(trigger);
    }, resumeDelayMs);
    resumeTimer?.unref?.();
  };

  const resetAndReload = () => {
    if (disposed || win.isDestroyed() || isQuitting()) return Promise.resolve(false);
    tripped = false;
    crashTimestamps.length = 0;
    return attemptRecovery("manual");
  };

  const onRenderProcessGone = (_event, details) => {
    if (disposed || win.isDestroyed() || isQuitting()) return;
    const reason = details?.reason ?? "unknown";
    if (reason === "clean-exit") return;
    stopStableTimer();
    if (tripped) {
      log(`renderer recovery: ignored repeat crash (${reason}) while circuit open`);
      return;
    }
    const t = now();
    const cutoff = t - windowMs;
    while (crashTimestamps.length > 0 && crashTimestamps[0] <= cutoff) crashTimestamps.shift();
    crashTimestamps.push(t);
    if (crashTimestamps.length > maxCrashes) {
      tripped = true;
      pendingRecovery = false;
      stopResumeTimer();
      log(`renderer recovery: circuit open after ${crashTimestamps.length} crashes in ${windowMs}ms (${reason})`);
      onCircuitOpen?.({ reason, count: crashTimestamps.length, resetAndReload });
      return;
    }
    if (suspended) {
      pendingRecovery = true;
      log(`renderer recovery: deferred crash (${reason}) until system resumes`);
      return;
    }
    void attemptRecovery("crash");
  };

  const onDidStartNavigation = (event, _url, _isInPlace, isMainFrame) => {
    const main = typeof event?.isMainFrame === "boolean" ? event.isMainFrame : isMainFrame !== false;
    if (!main || recovering) return;
    pendingRecovery = false;
    stopResumeTimer();
  };

  const onDidFinishLoad = () => {
    stopStableTimer();
    if (disposed || win.isDestroyed()) return;
    let url = "";
    try {
      url = contents.getURL?.() ?? "";
    } catch {}
    if (!isHttpUrl(url)) return;
    stableTimer = setTimer(() => {
      stableTimer = null;
      tripped = false;
      crashTimestamps.length = 0;
    }, stableMs);
    stableTimer?.unref?.();
  };

  const onSuspend = () => {
    suspended = true;
    stopResumeTimer();
  };

  const onResume = () => {
    suspended = false;
    scheduleResumeRecovery("resume");
  };

  const onUnlock = () => {
    suspended = false;
    scheduleResumeRecovery("unlock-screen");
  };

  const onFocusOrShow = () => {
    if (!suspended && pendingRecovery && !tripped && !recovering && resumeTimer === null) {
      void attemptRecovery("focus");
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopStableTimer();
    stopResumeTimer();
    contents.off?.("render-process-gone", onRenderProcessGone);
    contents.off?.("did-start-navigation", onDidStartNavigation);
    contents.off?.("did-finish-load", onDidFinishLoad);
    win.off?.("show", onFocusOrShow);
    win.off?.("focus", onFocusOrShow);
    powerMonitor?.off?.("suspend", onSuspend);
    powerMonitor?.off?.("resume", onResume);
    powerMonitor?.off?.("unlock-screen", onUnlock);
  };

  contents.on("render-process-gone", onRenderProcessGone);
  contents.on("did-start-navigation", onDidStartNavigation);
  contents.on("did-finish-load", onDidFinishLoad);
  win.on("show", onFocusOrShow);
  win.on("focus", onFocusOrShow);
  powerMonitor?.on?.("suspend", onSuspend);
  powerMonitor?.on?.("resume", onResume);
  powerMonitor?.on?.("unlock-screen", onUnlock);
  win.once("closed", dispose);

  return {
    dispose,
    resetAndReload,
    state: () => ({ suspended, pendingRecovery, recovering, tripped, recentCrashes: crashTimestamps.length }),
  };
}
