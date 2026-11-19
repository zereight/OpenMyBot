// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererErrorDiagnostics, reportRendererDiagnostic } from "./renderer-diagnostics";

afterEach(() => {
  delete (window as { ogb?: unknown }).ogb;
  vi.restoreAllMocks();
});

describe("renderer-diagnostics", () => {
  it("reports uncaught window errors and unhandled rejections with only the error name", () => {
    const reportDiagnostic = vi.fn();
    (window as { ogb?: unknown }).ogb = { reportDiagnostic };
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const target = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const fn = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const fn = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
        listeners.get(type)?.delete(fn);
      },
    };

    const dispose = installRendererErrorDiagnostics(target);
    for (const fn of listeners.get("error") ?? []) {
      fn({ error: new TypeError("private detail /Users/someone/notes.txt") } as unknown as Event);
    }
    for (const fn of listeners.get("unhandledrejection") ?? []) {
      fn({ reason: new DOMException("private detail", "AbortError") } as unknown as Event);
    }

    expect(reportDiagnostic).toHaveBeenNthCalledWith(1, {
      kind: "renderer-error",
      origin: "error",
      error: { name: "TypeError" },
    });
    expect(reportDiagnostic).toHaveBeenNthCalledWith(2, {
      kind: "renderer-error",
      origin: "unhandledrejection",
      error: { name: "AbortError" },
    });

    dispose();
    expect(listeners.get("error")?.size).toBe(0);
    expect(listeners.get("unhandledrejection")?.size).toBe(0);
  });

  it("ignores missing or throwing desktop bridges", () => {
    expect(() => reportRendererDiagnostic({ kind: "api-timeout", method: "GET", timeoutMs: 30_000 })).not.toThrow();
    (window as { ogb?: unknown }).ogb = {
      reportDiagnostic: () => {
        throw new Error("bridge failed");
      },
    };
    expect(() => reportRendererDiagnostic({ kind: "api-timeout", method: "GET", timeoutMs: 30_000 })).not.toThrow();
  });
});
