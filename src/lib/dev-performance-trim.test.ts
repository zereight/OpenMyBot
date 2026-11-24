import { describe, expect, it, vi } from "vitest";
import { installDevPerformanceTrim, trimDevPerformanceEntries } from "./dev-performance-trim";

describe("dev-performance-trim", () => {
  it("clears measures and marks only when they exceed the cap", () => {
    let measures = Array.from({ length: 600 }, () => ({}) as PerformanceEntry);
    let marks = Array.from({ length: 10 }, () => ({}) as PerformanceEntry);
    const perf = {
      getEntriesByType: (type: string) => (type === "measure" ? measures : marks),
      clearMeasures: vi.fn(() => { measures = []; }),
      clearMarks: vi.fn(() => { marks = []; }),
    };

    expect(trimDevPerformanceEntries(perf, 500)).toEqual({ clearedMeasures: 600, clearedMarks: 0 });
    expect(perf.clearMeasures).toHaveBeenCalledTimes(1);
    expect(perf.clearMarks).not.toHaveBeenCalled();
    expect(trimDevPerformanceEntries(perf, 500)).toEqual({ clearedMeasures: 0, clearedMarks: 0 });
  });

  it("trims on interval and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      let measures = Array.from({ length: 501 }, () => ({}) as PerformanceEntry);
      const perf = {
        getEntriesByType: (type: string) => (type === "measure" ? measures : []),
        clearMeasures: vi.fn(() => { measures = []; }),
        clearMarks: vi.fn(),
      };
      const stop = installDevPerformanceTrim(perf, 5_000, 500);
      vi.advanceTimersByTime(5_000);
      expect(perf.clearMeasures).toHaveBeenCalledTimes(1);
      stop();
      measures = Array.from({ length: 600 }, () => ({}) as PerformanceEntry);
      vi.advanceTimersByTime(10_000);
      expect(perf.clearMeasures).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
