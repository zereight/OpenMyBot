// The fixed --cost cap misses a bot whose turns usually cost cents and then cost a few dollars.
// Event logs are read from a byte offset, so the baseline lives in state.json and is passed in.
import { signatureOf } from "../normalize.ts";
import type { Detector, Observation, SentinelRecord } from "../types.ts";

/** How many recent turn costs are kept per bot. */
export const COST_SPIKE_WINDOW = 20;
/** A spike needs this many earlier turns, so a new bot is not flagged on its first expensive task. */
export const COST_SPIKE_MIN = 8;
/** The turn must cost more than this multiple of the median of those earlier turns. */
export const COST_SPIKE_FACTOR = 5;
/** And more than this many dollars, so a jump between fractions of a cent is not an issue. */
export const COST_SPIKE_FLOOR_USD = 1;

export function nextCostHistory(
  history: Readonly<Record<string, readonly number[]>>,
  records: readonly SentinelRecord[],
): Record<string, number[]> {
  const next = copyHistory(history);
  for (const record of pricedTurns(records)) {
    const key = record.botId ?? "";
    const prior = next[key] ?? [];
    // A spike is not the new usual. Counting it would hide the next one, and it is already an issue.
    if (!isSpike(record.cost, prior)) next[key] = [...prior, record.cost].slice(-COST_SPIKE_WINDOW);
  }
  return next;
}

export const costSpike: Detector = {
  name: "cost_spike",
  detect(records, config) {
    const observations: Observation[] = [];
    const history = copyHistory(config.costHistory);
    for (const record of pricedTurns(records)) {
      const key = record.botId ?? "";
      const prior = history[key] ?? [];
      if (!isSpike(record.cost, prior)) {
        history[key] = [...prior, record.cost].slice(-COST_SPIKE_WINDOW);
        continue;
      }
      const usual = median(prior);
      observations.push({
        kind: "cost_spike",
        signature: signatureOf("cost_spike", record.botId),
        title: `a turn cost $${record.cost.toFixed(2)}, over ${COST_SPIKE_FACTOR}× ${record.botId ? "this bot's usual" : "the usual"} $${usual.toFixed(2)}`,
        origin: "harness",
        severity: "medium",
        threadId: record.threadId,
        at: record.at,
        occurrence: `turn:${record.id}`,
        evidence: { source: "events", id: record.id },
        ...(record.botId ? { botId: record.botId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
      });
    }
    return observations;
  },
};

function copyHistory(history: Readonly<Record<string, readonly number[]>>): Record<string, number[]> {
  const next: Record<string, number[]> = {};
  for (const [key, values] of Object.entries(history)) next[key] = values.slice(-COST_SPIKE_WINDOW);
  return next;
}

type PricedTurn = Extract<SentinelRecord, { type: "turn" }> & { cost: number };

function pricedTurns(records: readonly SentinelRecord[]): PricedTurn[] {
  return records
    .filter((record): record is PricedTurn => record.type === "turn" && typeof record.cost === "number" && Number.isFinite(record.cost) && record.cost >= 0)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isSpike(cost: number, prior: readonly number[]): boolean {
  if (prior.length < COST_SPIKE_MIN) return false;
  // Compare cents, so a cost that is exactly 5× the median is not a spike (0.2 × 5 is not 1 in binary).
  const costCents = Math.round(cost * 100);
  return costCents > Math.round(COST_SPIKE_FLOOR_USD * 100) && costCents > Math.round(median(prior) * 100) * COST_SPIKE_FACTOR;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
