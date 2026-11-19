// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  delete (window as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api() timeout diagnostics", () => {
  it("reports api-timeout when a request with timeoutMs fails with TimeoutError", async () => {
    const reportDiagnostic = vi.fn();
    (window as { ogb?: unknown }).ogb = { reportDiagnostic };
    const timeoutErr = new DOMException("The operation timed out.", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr; }));

    await expect(api("/api/bots/123/tasks/t1", { method: "POST", timeoutMs: 30_000 })).rejects.toBe(timeoutErr);
    expect(reportDiagnostic).toHaveBeenCalledWith({
      kind: "api-timeout",
      method: "POST",
      timeoutMs: 30_000,
    });
  });

  it("does not report api-timeout for caller-initiated AbortError", async () => {
    const reportDiagnostic = vi.fn();
    (window as { ogb?: unknown }).ogb = { reportDiagnostic };
    const abortErr = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortErr; }));

    const controller = new AbortController();
    await expect(api("/api/bots", { signal: controller.signal, timeoutMs: 30_000 })).rejects.toBe(abortErr);
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });

  it("does not report api-timeout when timeoutMs is omitted", async () => {
    const reportDiagnostic = vi.fn();
    (window as { ogb?: unknown }).ogb = { reportDiagnostic };
    const timeoutErr = new DOMException("Timed out", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr; }));

    await expect(api("/api/bots")).rejects.toBe(timeoutErr);
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});
