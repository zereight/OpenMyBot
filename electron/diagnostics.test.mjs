import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  appendDesktopCrashRecord,
  attachPowerMonitorDiagnostics,
  attachWindowDiagnosticListeners,
  buildDiagnosticsReport,
  createDesktopDiagnosticLimiter,
  decodeLogTail,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  formatRendererDiagnosticRecord,
  installDesktopCrashListeners,
  installDesktopDiagnostics,
  readSafeLogTail,
  redactSecretsInLine,
  CREDENTIAL_ENV_NAMES,
} = require("./diagnostics.mjs");

// The desktop credential list is a hand copy of server/credential-env.ts WORKSPACE_CREDENTIAL_ENV; this test is the drift alarm.
describe("credential env parity with server/credential-env.ts", () => {
  it("matches WORKSPACE_CREDENTIAL_ENV exactly", () => {
    const config = readFileSync(new URL("../server/credential-env.ts", import.meta.url), "utf8");
    const match = config.match(/WORKSPACE_CREDENTIAL_ENV = \[([\s\S]*?)\] as const/);
    expect(match).not.toBeNull();
    const names = [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(CREDENTIAL_ENV_NAMES).toEqual(names);
  });
});

describe("buildDiagnosticsReport", () => {
  const appInfo = {
    version: "0.1.27",
    platform: "darwin",
    arch: "arm64",
    electron: "43.4.0",
    node: "24.0.0",
    packaged: true,
    uptimeSeconds: 42,
  };

  it("renders app facts and a sorted config summary", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {
        xai: { configured: true },
        box: { configured: false },
        rooms: { turnTimeoutMinutes: 5 },
      },
      logTail: "",
    });
    expect(report).toContain("version=0.1.27");
    expect(report).toContain("platform=darwin");
    expect(report).toContain("arch=arm64");
    expect(report).toContain("xai.configured=true");
    expect(report).toContain("box.configured=false");
    expect(report).toContain("rooms.turnTimeoutMinutes=5");
    expect(report).toContain("(no desktop crash events available)");
    expect(report).toContain("(server log unavailable)");
    expect(report).toContain("(updater log unavailable)");
  });

  it("includes updater diagnostics separately and redacts signed redirects and headers", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      logTail: "server ready",
      updaterLogTail: [
        "[info] Downloading version 0.1.61",
        "[error] GET https://release-assets.example.test/update.zip?X-Amz-Credential=private-account&X-Amz-Signature=signed-secret&jwt=private-jwt HTTP 403",
        'headers {"authorization":"Basic dXNlcjpwYXNzd29yZA==","apiKey":"opaque-private-key"}',
        "Set-Cookie: session=private-session; Secure; HttpOnly",
      ].join("\n"),
    });
    expect(report).toContain("## Updater log tail — credentials and URL parameters auto-masked");
    expect(report).toContain("Downloading version 0.1.61");
    expect(report).toContain("https://release-assets.example.test/update.zip?«redacted URL parameters» HTTP 403");
    for (const secret of ["private-account", "signed-secret", "private-jwt", "dXNlcjpwYXNzd29yZA==", "opaque-private-key", "private-session"]) {
      expect(report).not.toContain(secret);
    }
    expect(report.indexOf("server ready")).toBeLessThan(report.indexOf("Downloading version 0.1.61"));
  });

  it.each(["", null, undefined])("handles an absent updater log (%s)", (updaterLogTail) => {
    expect(buildDiagnosticsReport({ appInfo, updaterLogTail })).toContain("(updater log unavailable)");
  });

  it("removes URL userinfo, fragments, and unfamiliar query capabilities without hiding public paths", () => {
    const line = "GET https://private-user:private-password@updates.example.test/update.zip?%73ig=encoded-secret#fragment-secret\n"
      + "GET https://updates.example.test/latest-mac.yml\n"
      + "GET https://updates.example.test/update.zip#private-fragment";
    const redacted = redactSecretsInLine(line);
    expect(redacted).toContain("https://«redacted credentials»@updates.example.test/update.zip?«redacted URL parameters»");
    expect(redacted).toContain("https://updates.example.test/latest-mac.yml");
    for (const secret of ["private-user", "private-password", "encoded-secret", "fragment-secret", "private-fragment"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("masks JSON credential fields and cookies in updater HTTP dumps", () => {
    const redacted = redactSecretsInLine([
      '{"OMB_COMPOSIO_BROKER_TOKEN":"opaque-broker-value","password":"opaque-password-value"}',
      '{"Cookie":"session=private-cookie; tracking=private-tracker"}',
      "Cookie: session=private-session; tracking=private-tracking",
    ].join("\n"));
    for (const secret of ["opaque-broker-value", "opaque-password-value", "private-cookie", "private-tracker", "private-session", "private-tracking"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("masks Groq keys in diagnostic log exports while retaining useful status", () => {
    const key = `gsk_${"a".repeat(48)}`;
    const otherKey = `gsk_${"b".repeat(48)}`;
    const workspaceKey = "opaque-groq-fixture-key";
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: { groq: { configured: true } },
      logTail: `Groq HTTP 401: invalid key ${key}\nspawn env OMB_GROQ_API_KEY=${workspaceKey}`,
      updaterLogTail: `upstream rejected ${otherKey}`,
    });
    for (const secret of [key, otherKey, workspaceKey]) expect(report).not.toContain(secret);
    expect(report).toContain("groq.configured=true");
    expect(report).toContain("Groq HTTP 401");
  });

  it("masks long-term and temporary AWS access key ids", () => {
    const longTerm = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const temporary = `ASIA${"QRSTUVWXYZ234567"}`;
    const redacted = redactSecretsInLine(`aws ${longTerm} then sts ${temporary} done`);
    for (const id of [longTerm, temporary]) expect(redacted).not.toContain(id);
    expect(redacted).toContain("done");
  });

  it("includes privacy-safe desktop crash metadata separately from the server log", () => {
    const desktopLogTail =
      "[2026-08-31T11:00:00.000Z] event=render-process-gone surface=main-window reason=crashed exitCode=5";
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      desktopLogTail,
      logTail: "server ready",
    });
    expect(report).toContain("## Desktop crash events — privacy-safe metadata only");
    expect(report).toContain(desktopLogTail);
    expect(report.indexOf(desktopLogTail)).toBeLessThan(report.indexOf("server ready"));
  });

  it("redacts desktop crash lines again before exporting them", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      desktopLogTail: "event=future-crash token=abcdefghijklmnop",
      logTail: "",
    });
    expect(report).not.toContain("abcdefghijklmnop");
    expect(report).toContain("token=«redacted");
  });

  it("drops strings, non-scalars and credential-shaped summary values", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {
        xai: { key: "xai-real-secret" },
        composio: { apiKey: "ak_live_abcdef123456789" },
        vps: { sshAlias: "" },
        profile: { name: "Ada" },
        instances: [{ driver: "claudeAgent", environment: { TOKEN: "hunter2" } }],
        note: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      },
      logTail: "",
    });
    expect(report).not.toContain("xai-real-secret");
    expect(report).not.toContain("ak_live_abcdef123456789");
    expect(report).not.toContain("hunter2");
    expect(report).not.toContain("driver");
    expect(report).not.toContain("environment");
    expect(report).not.toContain("profile.name=");
    expect(report).not.toContain("Ada");
    expect(report).not.toContain("note=");
  });

  it("never includes an absolute log path in the report heading", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: "server ready",
      logPath: "/Users/ada/Library/Logs/OpenMausBot/server.log",
    });
    expect(report).toContain("## Server log tail");
    expect(report).not.toContain("/Users/ada");
  });

  it.each(CREDENTIAL_ENV_NAMES)("masks any value riding on %s in the log tail", (name) => {
    const value = "s3cr3t-value-123456";
    const line = `spawn env ${name}=${value} ready`;
    const report = buildDiagnosticsReport({ appInfo, configSummary: {}, logTail: line });
    expect(report).not.toContain(value);
    expect(redactSecretsInLine(line)).toBe(`spawn env ${name}=«redacted ${value.length} chars» ready`);
  });

  it("masks generic key=value secrets and content-shaped tokens in the log tail", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: [
        'config {"apiKey":"sk-proj-abcdefghijklmnop"}',
        "Authorization: Bearer abcdefghijklmnop",
        "password=hunter2000",
      ].join("\n"),
    });
    expect(report).not.toContain("sk-proj-abcdefghijklmnop");
    expect(report).not.toContain("abcdefghijklmnop");
    expect(report).not.toContain("hunter2000");
    expect(report).toContain("«redacted");
  });

  it.each(["Bearer abcdefghijklmnop", "Basic dXNlcjpwYXNzd29yZA=="])(
    "masks the full Authorization credential for %s",
    (authorization) => {
      const report = buildDiagnosticsReport({
        appInfo,
        configSummary: {},
        logTail: `request Authorization: ${authorization}`,
      });
      expect(report).not.toContain(authorization);
      expect(report).not.toContain(authorization.split(" ")[1]);
      expect(report).toContain("Authorization=«redacted");
    },
  );

  it("masks a multiline PEM private key as one value", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: [
        "loading credential",
        "-----BEGIN PRIVATE KEY-----",
        "super-secret-line-one",
        "super-secret-line-two",
        "-----END PRIVATE KEY-----",
        "ready",
      ].join("\n"),
    });
    expect(report).not.toContain("super-secret-line-one");
    expect(report).not.toContain("super-secret-line-two");
    expect(report).toContain("«redacted private key»");
  });

  it("leaves ordinary log lines untouched", () => {
    const line = "[2026-08-22T20:00:00.000Z] [out] fork server/index.js port=8799 spawned pid=4242";
    expect(redactSecretsInLine(line)).toBe(line);
  });

  it("handles an empty or missing log gracefully", () => {
    for (const logTail of ["", null, undefined]) {
      const report = buildDiagnosticsReport({ appInfo, configSummary: {}, logTail });
      expect(report).toContain("(server log unavailable)");
      expect(report.endsWith("\n")).toBe(true);
    }
  });

  it("keeps long prose lines that merely mention a key by name", () => {
    const line = "user asked whether the XAI_API_KEY variable needs to be set manually";
    expect(redactSecretsInLine(line)).toBe(line);
  });
});

describe("formatDesktopCrashRecord", () => {
  it("records renderer and child failures without accepting arbitrary fields", () => {
    expect(
      formatDesktopCrashRecord({
        kind: "renderer",
        surface: "main-window",
        reason: "crashed",
        exitCode: 9,
        url: "https://example.test/private?token=secret",
      }),
    ).toBe("event=render-process-gone surface=main-window reason=crashed exitCode=9");
    expect(
      formatDesktopCrashRecord({
        kind: "child",
        type: "GPU",
        reason: "oom",
        exitCode: 34,
        commandLine: "--password=secret",
      }),
    ).toBe("event=child-process-gone type=GPU reason=oom exitCode=34");
  });

  it("omits normal clean exits", () => {
    expect(formatDesktopCrashRecord({ kind: "renderer", reason: "clean-exit" })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "child", reason: "clean-exit" })).toBeNull();
  });

  it("reduces a fatal main-process error to its type without reading its message or stack", () => {
    const error = new TypeError("secret user text from C:\\Users\\Ada\\private.txt");
    error.stack = [
      "TypeError: secret user text from C:\\Users\\Ada\\private.txt",
      "secret-client.ts:1:1",
      "    at boot (file:///C:/Users/Ada/OpenMyBot/electron/main.mjs:412:7)",
    ].join("\n");
    const record = formatDesktopCrashRecord({ kind: "main", origin: "unhandledRejection", error });
    expect(record).toBe("event=main-process-failure origin=unhandledRejection error=TypeError");
    expect(record).not.toContain("Ada");
    expect(record).not.toContain("secret user text");
    expect(record).not.toContain("secret-client");
  });

  it("fails closed for unknown Electron metadata", () => {
    expect(
      formatDesktopCrashRecord({
        kind: "renderer",
        surface: "private-window-name",
        reason: "token=super-secret",
        exitCode: "5; password=secret",
      }),
    ).toBe("event=render-process-gone surface=auxiliary reason=unknown exitCode=unknown");
    expect(formatDesktopCrashRecord({ kind: "anything", payload: "secret" })).toBeNull();
  });
});

describe("installDesktopCrashListeners", () => {
  it("observes fatal, renderer and child failures through structural fields only", () => {
    const appTarget = new EventEmitter();
    const processTarget = new EventEmitter();
    const records = [];
    const mainContents = {};
    const dispose = installDesktopCrashListeners({
      appTarget,
      processTarget,
      record: (event) => records.push(event),
      mainWebContents: () => mainContents,
    });
    const error = new TypeError("private message");
    processTarget.emit("uncaughtExceptionMonitor", error, "unhandledRejection");
    appTarget.emit(
      "render-process-gone",
      {},
      mainContents,
      { reason: "crashed", exitCode: 7, url: "https://private.test" },
    );
    appTarget.emit(
      "child-process-gone",
      {},
      { type: "GPU", reason: "oom", exitCode: 34, name: "private-service" },
    );
    expect(records).toEqual([
      { kind: "main", error, origin: "unhandledRejection" },
      { kind: "renderer", surface: "main-window", reason: "crashed", exitCode: 7 },
      { kind: "child", type: "GPU", reason: "oom", exitCode: 34 },
    ]);
    dispose();
    expect(processTarget.listenerCount("uncaughtExceptionMonitor")).toBe(0);
    expect(appTarget.listenerCount("render-process-gone")).toBe(0);
    expect(appTarget.listenerCount("child-process-gone")).toBe(0);
  });

  it("ignores process exits after Electron has begun its normal shutdown", () => {
    const appTarget = new EventEmitter();
    const processTarget = new EventEmitter();
    const records = [];
    installDesktopCrashListeners({
      appTarget,
      processTarget,
      record: (event) => records.push(event),
      isShuttingDown: () => true,
    });
    appTarget.emit("render-process-gone", {}, {}, { reason: "killed", exitCode: 0 });
    appTarget.emit("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: 0 });
    expect(records).toEqual([]);
  });
});

describe("hang, power, and renderer diagnostic events", () => {
  it("formats allowlisted hang, power, load-failure, preload, renderer-error, and api-timeout metadata", () => {
    expect(formatDesktopCrashRecord({ kind: "unresponsive", surface: "main-window" })).toBe(
      "event=window-unresponsive surface=main-window",
    );
    expect(formatDesktopCrashRecord({ kind: "responsive", surface: "other" })).toBe(
      "event=window-responsive surface=auxiliary",
    );
    expect(formatDesktopCrashRecord({ kind: "power", state: "suspend" })).toBe("event=power-state state=suspend");
    expect(formatDesktopCrashRecord({ kind: "power", state: "secret-state" })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "did-fail-load", surface: "main-window", errorCode: -105 })).toBe(
      "event=did-fail-load surface=main-window errorCode=-105",
    );
    expect(formatDesktopCrashRecord({ kind: "did-fail-load", surface: "main-window", errorCode: -3 })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "preload-error", surface: "main-window", error: new TypeError("secret path") })).toBe(
      "event=preload-error surface=main-window error=TypeError",
    );
    expect(formatDesktopCrashRecord({ kind: "renderer-error", origin: "error-boundary", error: { name: "ChunkLoadError" } })).toBe(
      "event=renderer-error origin=error-boundary error=ChunkLoadError",
    );
    expect(formatDesktopCrashRecord({ kind: "renderer-error", origin: "unhandledrejection", error: { name: "DOMException" } })).toBe(
      "event=renderer-error origin=unhandledrejection error=DOMException",
    );
    expect(formatDesktopCrashRecord({ kind: "renderer-error", origin: "error", error: { name: "PrivateTokenError" } })).toBe(
      "event=renderer-error origin=error error=Error",
    );
    expect(formatDesktopCrashRecord({ kind: "renderer-error", origin: "unknown-origin", error: { name: "TypeError" } })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "api-timeout", method: "POST", timeoutMs: 30_000 })).toBe(
      "event=api-timeout method=POST timeoutMs=30000",
    );
    expect(formatDesktopCrashRecord({ kind: "api-timeout", method: "GET", timeoutMs: 5 })).toBe(
      "event=api-timeout method=GET timeoutMs=100",
    );
    expect(formatDesktopCrashRecord({ kind: "api-timeout", method: "GET", timeoutMs: 9_999_999 })).toBe(
      "event=api-timeout method=GET timeoutMs=600000",
    );
    expect(formatDesktopCrashRecord({ kind: "api-timeout", method: "BREW", timeoutMs: 30_000 })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "api-timeout", method: "GET", timeoutMs: -1 })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "api-timeout", method: "GET", timeoutMs: "30000" })).toBeNull();
  });

  it("restricts renderer IPC formatting to renderer-scoped kinds", () => {
    expect(formatRendererDiagnosticRecord({ kind: "renderer-error", origin: "error", error: { name: "TypeError" } })).toBe(
      "event=renderer-error origin=error error=TypeError",
    );
    expect(formatRendererDiagnosticRecord({ kind: "api-timeout", method: "GET", timeoutMs: 30_000 })).toBe(
      "event=api-timeout method=GET timeoutMs=30000",
    );
    expect(formatRendererDiagnosticRecord({ kind: "main", origin: "uncaughtException", error: new Error("spoof") })).toBeNull();
    expect(formatRendererDiagnosticRecord({ kind: "renderer", reason: "crashed", exitCode: 1 })).toBeNull();
    expect(formatRendererDiagnosticRecord({ kind: "power", state: "suspend" })).toBeNull();
    expect(formatRendererDiagnosticRecord(null)).toBeNull();
  });

  it("deduplicates identical records and enforces the per-minute cap", () => {
    let clock = 100_000;
    const limiter = createDesktopDiagnosticLimiter({ maxPerMinute: 3, dedupeWindowMs: 60_000, now: () => clock });
    expect(limiter.allow("event=api-timeout method=GET timeoutMs=30000")).toBe(true);
    expect(limiter.allow("event=api-timeout method=GET timeoutMs=30000")).toBe(false);
    expect(limiter.allow("event=api-timeout method=POST timeoutMs=30000")).toBe(true);
    expect(limiter.allow("event=renderer-error origin=error error=TypeError")).toBe(true);
    expect(limiter.allow("event=renderer-error origin=error error=RangeError")).toBe(false);
    clock += 60_001;
    expect(limiter.allow("event=api-timeout method=GET timeoutMs=30000")).toBe(true);
  });

  it("records power state transitions without consecutive duplicates and detaches cleanly", () => {
    const powerMonitor = new EventEmitter();
    const records = [];
    const detach = attachPowerMonitorDiagnostics(powerMonitor, {
      record: (event) => records.push(event),
      isShuttingDown: () => false,
    });
    powerMonitor.emit("suspend");
    powerMonitor.emit("suspend");
    powerMonitor.emit("resume");
    powerMonitor.emit("lock-screen");
    powerMonitor.emit("unlock-screen");
    expect(records).toEqual([
      { kind: "power", state: "suspend" },
      { kind: "power", state: "resume" },
      { kind: "power", state: "lock-screen" },
      { kind: "power", state: "unlock-screen" },
    ]);
    detach();
    powerMonitor.emit("suspend");
    expect(records).toHaveLength(4);
  });

  it("records window unresponsive, responsive, main-frame did-fail-load, and preload-error events", () => {
    const win = new EventEmitter();
    win.webContents = new EventEmitter();
    const records = [];
    const detach = attachWindowDiagnosticListeners(win, {
      record: (event) => records.push(event),
      isShuttingDown: () => false,
      surface: "main-window",
    });
    win.emit("unresponsive");
    win.emit("responsive");
    win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://127.0.0.1/", true);
    win.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://127.0.0.1/frame", false);
    win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1/", true);
    const preloadErr = new SyntaxError("secret preload detail");
    win.webContents.emit("preload-error", {}, "/private/preload.cjs", preloadErr);
    expect(records).toEqual([
      { kind: "unresponsive", surface: "main-window" },
      { kind: "responsive", surface: "main-window" },
      { kind: "did-fail-load", surface: "main-window", errorCode: -102 },
      { kind: "preload-error", surface: "main-window", error: preloadErr },
    ]);
    detach();
    win.emit("unresponsive");
    expect(records).toHaveLength(4);
  });

  it("wires crash, window, power and renderer records into one log, limiting all but crashes", () => {
    const appTarget = new EventEmitter();
    const processTarget = new EventEmitter();
    const ipcTarget = new EventEmitter();
    const lines = [];
    let guard = () => true;
    const diagnostics = installDesktopDiagnostics({
      appTarget,
      processTarget,
      ipcTarget,
      append: (record) => lines.push(record),
      rendererAllowed: (event) => guard(event),
      limiter: createDesktopDiagnosticLimiter({ maxPerMinute: 10, dedupeWindowMs: 60_000, now: () => 1_000 }),
    });
    const win = new EventEmitter();
    win.webContents = new EventEmitter();
    const powerMonitor = new EventEmitter();
    diagnostics.attachWindow(win);
    diagnostics.attachPower(powerMonitor);

    win.emit("unresponsive");
    win.emit("responsive");
    win.emit("unresponsive"); // identical within a minute: once
    powerMonitor.emit("resume");
    ipcTarget.emit("desktop:report-diagnostic", {}, { kind: "api-timeout", method: "POST", timeoutMs: 30_000 });
    // A page may not forge main-process kinds, and malformed payloads are dropped.
    ipcTarget.emit("desktop:report-diagnostic", {}, { kind: "renderer", surface: "main-window", reason: "crashed" });
    ipcTarget.emit("desktop:report-diagnostic", {}, null);
    guard = () => false;
    ipcTarget.emit("desktop:report-diagnostic", {}, { kind: "renderer-error", origin: "error", error: { name: "TypeError" } });
    guard = () => { throw new Error("guard failed"); };
    expect(() => ipcTarget.emit("desktop:report-diagnostic", {}, { kind: "api-timeout", method: "GET", timeoutMs: 30_000 })).not.toThrow();
    const gone = { reason: "crashed", exitCode: 1 };
    appTarget.emit("render-process-gone", {}, {}, gone);
    appTarget.emit("render-process-gone", {}, {}, gone); // crashes are never deduplicated

    expect(lines).toEqual([
      "event=window-unresponsive surface=main-window",
      "event=window-responsive surface=main-window",
      "event=power-state state=resume",
      "event=api-timeout method=POST timeoutMs=30000",
      "event=render-process-gone surface=auxiliary reason=crashed exitCode=1",
      "event=render-process-gone surface=auxiliary reason=crashed exitCode=1",
    ]);
  });
});

describe("decodeLogTail", () => {
  it("preserves the full buffer when the read starts at the beginning", () => {
    expect(decodeLogTail(Buffer.from("first\nsecond"), false)).toEqual({ tail: "first\nsecond", bytes: 12 });
  });

  it("drops a credential assignment split by a bounded tail read", () => {
    const decoded = decodeLogTail(Buffer.from("RET=split-secret\nserver ready\n"), true);
    expect(decoded).toEqual({ tail: "server ready\n", bytes: 13 });
    expect(decoded.tail).not.toContain("split-secret");
  });

  it("returns an empty tail when a truncated buffer has no complete line", () => {
    expect(decodeLogTail(Buffer.from("partial-secret"), true)).toEqual({ tail: "", bytes: 0 });
  });
});

describe("readSafeLogTail", () => {
  it("exports only a bounded complete-line updater tail from an isolated log fixture", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmausbot-updater-diagnostics-"));
    try {
      const log = join(directory, "updater.log");
      const tail = "[info] update staged\n[error] https://updates.example.test/app.zip?jwt=private-query-token\n";
      writeFileSync(log, `${"old-private-line\n".repeat(20_000)}${tail}`, { mode: 0o600 });
      const result = readSafeLogTail(log);
      expect(result.bytes).toBeLessThanOrEqual(256 * 1024);
      expect(result.tail.endsWith(tail)).toBe(true);
      const report = buildDiagnosticsReport({ updaterLogTail: result.tail });
      expect(report).toContain("[info] update staged");
      expect(report).not.toContain("private-query-token");
      expect(report).not.toContain(directory);
      expect(readSafeLogTail(join(directory, "absent-updater.log"))).toBeNull();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reads a bounded tail from a regular app-owned log", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmausbot-log-tail-"));
    try {
      const log = join(directory, "server.log");
      writeFileSync(log, "partial-secret\nfirst\nsecond\n", { mode: 0o600 });
      expect(readSafeLogTail(log, 17)).toEqual({ tail: "first\nsecond\n", bytes: 13 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a log-path symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmausbot-log-symlink-"));
    try {
      const privateFile = join(directory, "private.txt");
      const log = join(directory, "desktop-crashes.log");
      writeFileSync(privateFile, "private user content", { mode: 0o600 });
      symlinkSync(privateFile, log);
      expect(readSafeLogTail(log)).toBeNull();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("diagnosticsFileName", () => {
  it("uses openmausbot-diagnostics-YYYYMMDD-HHmmss.txt", () => {
    expect(diagnosticsFileName(new Date(2026, 7, 22, 16, 5, 9))).toBe(
      "openmausbot-diagnostics-20260822-160509.txt",
    );
  });
});

it("appends a crash line, truncates a full log, and refuses a hard-linked one", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-crash-"));
  const file = join(dir, "logs", "desktop-crashes.log");
  appendDesktopCrashRecord(file, 64, "first crash");
  expect(readFileSync(file, "utf8")).toMatch(/^\[.+\] first crash\n$/);
  appendDesktopCrashRecord(file, 10, "second crash");
  expect(readFileSync(file, "utf8")).toMatch(/^\[.+\] second crash\n$/);
  linkSync(file, join(dir, "other"));
  appendDesktopCrashRecord(file, 1_000, "third crash");
  expect(readFileSync(file, "utf8")).not.toContain("third crash");
  rmSync(dir, { recursive: true, force: true });
});
