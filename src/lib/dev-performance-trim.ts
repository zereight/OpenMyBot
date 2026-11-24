/** React 19 dev builds add a performance.measure entry on every render and never clear them; Chromium keeps each entry's detail in native memory outside the V8 heap (react/react#34770). */
const MAX_DEV_MEASURES = 500;
const TRIM_EVERY_MS = 5_000;

export function installDevPerformanceTrim(): void {
  setInterval(() => {
    if (performance.getEntriesByType("measure").length > MAX_DEV_MEASURES) performance.clearMeasures();
  }, TRIM_EVERY_MS);
}
