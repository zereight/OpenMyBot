// The bundle is pasted into public issues: the collector never reads secrets, and everything is scrubbed again here.
import fs from "node:fs";
import path from "node:path";

// Mirrors WORKSPACE_CREDENTIAL_ENV in server/credential-env.ts; a test asserts the two lists never drift apart.
export const CREDENTIAL_ENV_NAMES = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "OMB_GROQ_API_KEY",
  "OMB_GREENFERENCE_API_KEY",
  "OMB_MODELGO_API_KEY",
  "OMB_META_API_KEY",
  "OMB_DEEPSEEK_API_KEY",
  "OMB_ANTHROPIC_API_KEY",
  "OMB_ANTHROPIC_API_URL",
  "OMB_HOSTED_MODEL_TOKEN",
  "OMB_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "OMB_OPENAI_API_KEY",
  "OMB_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_FISH_AUDIO_API_KEY",
  "OMB_GEMINI_API_KEY",
  "OMB_JEV_API_KEY",
  "OMB_OPENROUTER_DECIDER_KEY",
  "OMB_WORKERS_AI_TOKEN",
  "OMB_OPENAI_IMAGE_KEY",
  "OMB_CUSTOM_IMAGE_KEY",
  "OMB_GEMINI_IMAGE_KEY",
  "OMB_OPENAI_LIVE_KEY",
  "OMB_TREG_KEY",
  "OMB_POSTIZ_API_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  "OMB_CLOUD_BOAT_TOKEN",
  "OMB_CLOUD_VOICE_TOKEN",
  "OMB_CLOUD_DECIDER_TOKEN",
  "OMB_CLOUD_AI_TOKEN",
  "OMB_CLOUD_X_TOKEN",
  "OMB_CLOUD_HOSTING_TOKEN",
  "OMB_CLOUD_CONNECTED_APPS_GRANT",
  // Private even though they are not traditional API credentials.
  "OMB_BROWSER_CONNECTION",
  "OMB_USER_DATA",
  "OMB_BOAT_API",
];

// Kept in parity with server/redact.ts: unmistakable token formats are masked wherever they appear, keyed or not.
const CREDENTIAL_TOKEN_FORMATS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g,
  /\bak_[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
];
const KEY_VALUE_PAIR =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"',;)\]}]+)/gi;
const AUTHORIZATION =
  /\b(authorization)["']?\s*[:=]\s*(?:"|')?([A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z0-9._~+/=-]+)(?:"|')?/gi;
const COOKIE = /\b((?:set-)?cookie)["']?\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi;
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const PEM_BLOCK =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g;

const mask = (value) => `«redacted ${value.length} chars»`;
const unquote = (value) => value.replace(/^["']|["']$/g, "");

// String.raw keeps \s and \] intact when embedded in the env-name regexes below.
const VALUE_PART = String.raw`("[^"]*"|'[^']*'|[^\s"',;)\]}]+)`;

export function redactSecretsInLine(line) {
  let out = String(line ?? "");
  // Updater errors include signed redirect URLs: keep host and path, never userinfo, query or fragment.
  out = out.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    const query = url.search(/[?#]/);
    const address = query < 0 ? url : url.slice(0, query);
    return address.replace(/^(https?:\/\/)[^/]*@/i, "$1«redacted credentials»@")
      + (query < 0 ? "" : "?«redacted URL parameters»");
  });
  const alreadyMasked = (value) => String(value).includes("«redacted");
  for (const name of CREDENTIAL_ENV_NAMES) {
    out = out.replace(
      new RegExp(`\\b(${name})["']?\\s*[:=]\\s*${VALUE_PART}`, "gi"),
      (_match, key, value) => `${key}=${mask(unquote(value))}`,
    );
  }
  out = out.replace(AUTHORIZATION, (_match, key, value) => `${key}=${mask(value)}`);
  out = out.replace(COOKIE, (_match, key, value) => `${key}=${mask(unquote(value))}`);
  out = out.replace(BEARER, (_match, lead, token) => `${lead}${mask(token)}`);
  out = out.replace(PEM_BLOCK, (_match, open, close) => `${open}«redacted private key»${close}`);
  out = out.replace(KEY_VALUE_PAIR, (_match, key, value) =>
    alreadyMasked(value) ? _match : `${key}=${mask(unquote(value))}`,
  );
  for (const format of CREDENTIAL_TOKEN_FORMATS) out = out.replace(format, (found) => mask(found));
  return out;
}

export function decodeLogTail(buffer, truncated = false) {
  if (!Buffer.isBuffer(buffer)) return { tail: "", bytes: 0 };
  let complete = buffer;
  if (truncated) {
    const newline = buffer.indexOf(0x0a);
    complete = newline < 0 ? buffer.subarray(0, 0) : buffer.subarray(newline + 1);
  }
  return { tail: complete.toString("utf8"), bytes: complete.length };
}

/** The pre/post-open identity check closes the Windows gap where O_NOFOLLOW is unavailable. */
export function readSafeLogTail(logPath, maxBytes = 256 * 1024, platform = process.platform) {
  let handle = null;
  try {
    const before = fs.lstatSync(logPath);
    if (!before.isFile() || before.nlink !== 1) return null;
    const flags = fs.constants.O_RDONLY | (platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    handle = fs.openSync(logPath, flags);
    const after = fs.fstatSync(handle);
    if (!after.isFile() || after.nlink !== 1) return null;
    if (before.dev !== after.dev || before.ino !== after.ino) return null;
    const start = Math.max(0, after.size - maxBytes);
    const buffer = Buffer.alloc(after.size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    return decodeLogTail(buffer, start > 0);
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

// Metadata only: no URL, title, error message, command line or absolute path reaches the public export.
const PROCESS_GONE_REASONS = new Set([
  "abnormal-exit",
  "clean-exit",
  "crashed",
  "integrity-failure",
  "killed",
  "launch-failed",
  "oom",
]);
const CHILD_PROCESS_TYPES = new Set([
  "GPU",
  "Pepper Plugin",
  "Pepper Plugin Broker",
  "Sandbox helper",
  "Unknown",
  "Utility",
  "Zygote",
]);
const MAIN_FAILURE_ORIGINS = new Set(["uncaughtException", "unhandledRejection"]);
const RENDERER_ERROR_ORIGINS = new Set(["error", "unhandledrejection", "error-boundary"]);
const POWER_STATES = new Set(["suspend", "resume", "lock-screen", "unlock-screen"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const RENDERER_DIAGNOSTIC_KINDS = new Set(["renderer-error", "api-timeout"]);
const MIN_API_TIMEOUT_MS = 100;
const MAX_API_TIMEOUT_MS = 600_000;
const ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "ApiError",
  "ChunkLoadError",
  "DOMException",
  "Error",
  "EvalError",
  "NetworkError",
  "QuotaExceededError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

function known(value, allowed, fallback = "unknown") {
  return typeof value === "string" && allowed.has(value) ? value.replaceAll(" ", "-") : fallback;
}

function exitCode(value) {
  return Number.isSafeInteger(value) ? value : "unknown";
}

function safeErrorName(error) {
  try {
    return known(error?.name, ERROR_NAMES, "Error");
  } catch {
    return "Error";
  }
}

function safeTimeoutMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return Math.min(MAX_API_TIMEOUT_MS, Math.max(MIN_API_TIMEOUT_MS, value));
}

function safeSurface(value) {
  return value === "main-window" ? "main-window" : "auxiliary";
}

/** Unknown event shapes are dropped, not serialised, so new Electron fields cannot leak. */
export function formatDesktopCrashRecord(event = {}) {
  try {
    if (!event || typeof event !== "object") return null;
    if (event.kind === "renderer") {
      const reason = known(event.reason, PROCESS_GONE_REASONS);
      if (reason === "clean-exit") return null;
      return `event=render-process-gone surface=${safeSurface(event.surface)} reason=${reason} exitCode=${exitCode(event.exitCode)}`;
    }
    if (event.kind === "child") {
      const reason = known(event.reason, PROCESS_GONE_REASONS);
      if (reason === "clean-exit") return null;
      const type = known(event.type, CHILD_PROCESS_TYPES);
      return `event=child-process-gone type=${type} reason=${reason} exitCode=${exitCode(event.exitCode)}`;
    }
    if (event.kind === "main") {
      const origin = known(event.origin, MAIN_FAILURE_ORIGINS, "uncaughtException");
      return `event=main-process-failure origin=${origin} error=${safeErrorName(event.error)}`;
    }
    if (event.kind === "unresponsive") {
      return `event=window-unresponsive surface=${safeSurface(event.surface)}`;
    }
    if (event.kind === "responsive") {
      return `event=window-responsive surface=${safeSurface(event.surface)}`;
    }
    if (event.kind === "power") {
      const state = known(event.state, POWER_STATES, "");
      return state ? `event=power-state state=${state}` : null;
    }
    if (event.kind === "did-fail-load") {
      // Chromium -3 is ERR_ABORTED from a newer navigation, not a load failure.
      if (event.errorCode === -3) return null;
      return `event=did-fail-load surface=${safeSurface(event.surface)} errorCode=${exitCode(event.errorCode)}`;
    }
    if (event.kind === "preload-error") {
      return `event=preload-error surface=${safeSurface(event.surface)} error=${safeErrorName(event.error)}`;
    }
    if (event.kind === "renderer-error") {
      const origin = known(event.origin, RENDERER_ERROR_ORIGINS, "");
      if (!origin) return null;
      return `event=renderer-error origin=${origin} error=${safeErrorName(event.error)}`;
    }
    if (event.kind === "api-timeout") {
      const method = known(event.method, HTTP_METHODS, "");
      const timeoutMs = safeTimeoutMs(event.timeoutMs);
      if (!method || timeoutMs === null) return null;
      return `event=api-timeout method=${method} timeoutMs=${timeoutMs}`;
    }
  } catch {
  }
  return null;
}

/** Security boundary for renderer IPC: only renderer-scoped diagnostic kinds may be reported. */
export function formatRendererDiagnosticRecord(event) {
  if (!event || typeof event !== "object" || !RENDERER_DIAGNOSTIC_KINDS.has(event.kind)) return null;
  return formatDesktopCrashRecord(event);
}

/** Bounds noisy diagnostic writes so repeated timeouts or sleep loops cannot truncate real crash history. */
export function createDesktopDiagnosticLimiter({
  maxPerMinute = 10,
  dedupeWindowMs = 60_000,
  now = Date.now,
} = {}) {
  const recentTimestamps = [];
  const lastSeenByRecord = new Map();
  return {
    allow(record) {
      if (typeof record !== "string" || !record) return false;
      const t = now();
      const windowStart = t - 60_000;
      while (recentTimestamps.length > 0 && recentTimestamps[0] <= windowStart) {
        recentTimestamps.shift();
      }
      const dedupeStart = t - dedupeWindowMs;
      for (const [key, seenAt] of lastSeenByRecord) {
        if (seenAt <= dedupeStart) lastSeenByRecord.delete(key);
      }
      const lastSeen = lastSeenByRecord.get(record);
      if (lastSeen !== undefined && t - lastSeen < dedupeWindowMs) return false;
      if (recentTimestamps.length >= maxPerMinute) return false;
      recentTimestamps.push(t);
      lastSeenByRecord.set(record, t);
      return true;
    },
  };
}

// Electron's powerMonitor module cannot be accessed until app.whenReady() resolves.
export function attachPowerMonitorDiagnostics(powerMonitorTarget, {
  record,
  isShuttingDown = () => false,
}) {
  if (!powerMonitorTarget || typeof powerMonitorTarget.on !== "function") return () => {};
  let lastPowerState = null;
  const powerHandlers = [];
  for (const state of POWER_STATES) {
    const handler = () => {
      if (isShuttingDown() || lastPowerState === state) return;
      lastPowerState = state;
      record({ kind: "power", state });
    };
    powerMonitorTarget.on(state, handler);
    powerHandlers.push([state, handler]);
  }
  return () => {
    for (const [state, handler] of powerHandlers) {
      powerMonitorTarget.off?.(state, handler);
    }
  };
}

export function installDesktopCrashListeners({
  appTarget,
  processTarget,
  powerMonitorTarget = null,
  record,
  isShuttingDown = () => false,
  mainWebContents = () => null,
}) {
  const onMainFailure = (error, origin) => record({ kind: "main", error, origin });
  const onRendererGone = (_event, contents, details) => {
    if (isShuttingDown()) return;
    record({
      kind: "renderer",
      surface: contents === mainWebContents() ? "main-window" : "auxiliary",
      reason: details?.reason,
      exitCode: details?.exitCode,
    });
  };
  const onChildGone = (_event, details) => {
    if (isShuttingDown()) return;
    record({
      kind: "child",
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
    });
  };

  const detachPower = attachPowerMonitorDiagnostics(powerMonitorTarget, { record, isShuttingDown });
  processTarget.on("uncaughtExceptionMonitor", onMainFailure);
  appTarget.on("render-process-gone", onRendererGone);
  appTarget.on("child-process-gone", onChildGone);
  return () => {
    processTarget.off("uncaughtExceptionMonitor", onMainFailure);
    appTarget.off("render-process-gone", onRendererGone);
    appTarget.off("child-process-gone", onChildGone);
    detachPower();
  };
}

export function attachWindowDiagnosticListeners(win, {
  record,
  isShuttingDown = () => false,
  surface = "main-window",
}) {
  const onUnresponsive = () => {
    if (isShuttingDown()) return;
    record({ kind: "unresponsive", surface });
  };
  const onResponsive = () => {
    if (isShuttingDown()) return;
    record({ kind: "responsive", surface });
  };
  const onDidFailLoad = (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || isShuttingDown()) return;
    record({ kind: "did-fail-load", surface, errorCode });
  };
  const onPreloadError = (_event, _preloadPath, error) => {
    if (isShuttingDown()) return;
    record({ kind: "preload-error", surface, error });
  };

  win.on("unresponsive", onUnresponsive);
  win.on("responsive", onResponsive);
  win.webContents?.on("did-fail-load", onDidFailLoad);
  win.webContents?.on("preload-error", onPreloadError);
  return () => {
    win.off?.("unresponsive", onUnresponsive);
    win.off?.("responsive", onResponsive);
    win.webContents?.off?.("did-fail-load", onDidFailLoad);
    win.webContents?.off?.("preload-error", onPreloadError);
  };
}

/**
 * Wires every desktop diagnostic into one append-only log. Crash records are always written; hang, power and
 * renderer records pass a limiter so a flapping signal or an error loop cannot truncate real crash history.
 * attachWindow runs per main window; attachPower only after app.whenReady(), when powerMonitor exists.
 */
export function installDesktopDiagnostics({
  appTarget,
  processTarget,
  ipcTarget = null,
  append,
  rendererAllowed = () => false,
  isShuttingDown = () => false,
  mainWebContents = () => null,
  limiter = createDesktopDiagnosticLimiter(),
}) {
  const write = (record, limited) => {
    if (record && (!limited || limiter.allow(record))) append(record);
  };
  const recordLimited = (event) => write(formatDesktopCrashRecord(event), true);
  installDesktopCrashListeners({
    appTarget,
    processTarget,
    record: (event) => write(formatDesktopCrashRecord(event), false),
    isShuttingDown,
    mainWebContents,
  });
  // One-way IPC: an unauthorized sender or malformed event is dropped silently, never thrown into the main event loop.
  ipcTarget?.on("desktop:report-diagnostic", (event, payload) => {
    try {
      if (rendererAllowed(event)) write(formatRendererDiagnosticRecord(payload), true);
    } catch {}
  });
  return {
    attachWindow: (win, surface = "main-window") =>
      attachWindowDiagnosticListeners(win, { record: recordLimited, isShuttingDown, surface }),
    attachPower: (powerMonitorTarget) =>
      attachPowerMonitorDiagnostics(powerMonitorTarget, { record: recordLimited, isShuttingDown }),
  };
}

const APP_INFO_KEYS = ["version", "platform", "arch", "electron", "node", "packaged", "uptimeSeconds"];

// Only booleans and finite numbers pass: strings can carry names, paths or account identifiers.
const isFiniteNumber = (value) => Number.isFinite(value) && Object.prototype.toString.call(value) === "[object Number]";

function summaryAllows(value) {
  if (Object.prototype.toString.call(value) === "[object Boolean]") return true;
  return isFiniteNumber(value);
}

function flattenSummary(input, prefix = "", depth = 0, out = {}) {
  if (!input || Object.prototype.toString.call(input) !== "[object Object]") return out;
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) continue;
    if (value && Object.prototype.toString.call(value) === "[object Object]" && depth < 3)
      flattenSummary(value, path, depth + 1, out);
    else out[path] = value;
  }
  return out;
}

export function buildDiagnosticsReport({
  appInfo = {},
  configSummary = {},
  desktopLogTail,
  updaterLogTail,
  logTail,
  now = new Date().toISOString(),
} = {}) {
  const lines = [];
  lines.push("OpenMyBot diagnostics");
  lines.push(`Generated: ${now}`);
  lines.push("");
  lines.push("## App");
  for (const key of APP_INFO_KEYS) {
    if (appInfo[key] === undefined || appInfo[key] === null) continue;
    lines.push(`${key}=${String(appInfo[key])}`);
  }
  lines.push("");
  lines.push("## Configuration");
  lines.push("# presence/count/mode only — credentials stay OS-encrypted and are never read");
  const summary = flattenSummary(configSummary);
  let shown = 0;
  for (const key of Object.keys(summary).sort()) {
    if (!summaryAllows(summary[key])) continue;
    lines.push(`${key}=${summary[key]}`);
    shown += 1;
  }
  if (!shown) lines.push("(no configuration summary available)");
  lines.push("");
  lines.push("## Desktop crash events — privacy-safe metadata only");
  if (desktopLogTail && desktopLogTail.trim()) {
    for (const line of redactSecretsInLine(desktopLogTail).split(/\r?\n/)) lines.push(line);
  } else {
    lines.push("(no desktop crash events available)");
  }
  lines.push("");
  lines.push(logTail && logTail.trim() ? "## Server log tail — known credential patterns auto-masked" : "## Server log tail");
  if (logTail && logTail.trim()) {
    for (const line of redactSecretsInLine(logTail).split(/\r?\n/)) lines.push(line);
  } else {
    lines.push("(server log unavailable)");
  }
  lines.push("");
  lines.push("## Updater log tail — credentials and URL parameters auto-masked");
  if (updaterLogTail && updaterLogTail.trim()) {
    for (const line of redactSecretsInLine(updaterLogTail).split(/\r?\n/)) lines.push(line);
  } else {
    lines.push("(updater log unavailable)");
  }
  lines.push("");
  return lines.join("\n");
}

export function diagnosticsFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `openmausbot-diagnostics-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`
  );
}

/** One line in the desktop crash log: refuses a link or a hard-linked target, starts over past maxBytes, owner-only. */
export function appendDesktopCrashRecord(file, maxBytes, record) {
  if (!record) return;
  let handle = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const win = process.platform === "win32";
    // On Windows an O_APPEND handle has no plain write access, so it cannot be truncated: write at an explicit offset there.
    const flags = fs.constants.O_WRONLY | (win ? 0 : fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    let before = null;
    try {
      before = fs.lstatSync(file);
      if (!before.isFile() || before.nlink !== 1) return;
      handle = fs.openSync(file, flags);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      // O_EXCL makes first creation race-safe on Windows, which has no O_NOFOLLOW.
      try { handle = fs.openSync(file, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); } catch { return; }
    }
    const stats = fs.fstatSync(handle);
    if (!stats.isFile() || stats.nlink !== 1) return;
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) return;
    let offset = stats.size;
    if (stats.size >= maxBytes) { fs.ftruncateSync(handle, 0); offset = 0; }
    if (!win) fs.fchmodSync(handle, 0o600);
    const line = Buffer.from(`[${new Date().toISOString()}] ${record}\n`, "utf8");
    fs.writeSync(handle, line, 0, line.length, win ? offset : null);
  } catch {
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch {} }
  }
}
