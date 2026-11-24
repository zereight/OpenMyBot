export const MAX_DEV_PERFORMANCE_ENTRIES = 500;
export const DEV_PERFORMANCE_TRIM_INTERVAL_MS = 5_000;

type PerformanceLike = Pick<Performance, "getEntriesByType" | "clearMeasures" | "clearMarks">;

export function trimDevPerformanceEntries(
  perf: PerformanceLike | undefined = typeof performance !== "undefined" ? performance : undefined,
  maxEntries = MAX_DEV_PERFORMANCE_ENTRIES,
): { clearedMeasures: number; clearedMarks: number } {
  if (!perf || typeof perf.getEntriesByType !== "function") return { clearedMeasures: 0, clearedMarks: 0 };
  const measureCount = perf.getEntriesByType("measure").length;
  const markCount = perf.getEntriesByType("mark").length;
  let clearedMeasures = 0;
  let clearedMarks = 0;
  if (measureCount > maxEntries && typeof perf.clearMeasures === "function") {
    perf.clearMeasures();
    clearedMeasures = measureCount;
  }
  if (markCount > maxEntries && typeof perf.clearMarks === "function") {
    perf.clearMarks();
    clearedMarks = markCount;
  }
  return { clearedMeasures, clearedMarks };
}

export function installDevPerformanceTrim(
  perf: PerformanceLike | undefined = typeof performance !== "undefined" ? performance : undefined,
  intervalMs = DEV_PERFORMANCE_TRIM_INTERVAL_MS,
  maxEntries = MAX_DEV_PERFORMANCE_ENTRIES,
): () => void {
  if (!perf || typeof setInterval !== "function") return () => {};
  const timer = setInterval(() => {
    trimDevPerformanceEntries(perf, maxEntries);
  }, intervalMs);
  return () => clearInterval(timer);
}
