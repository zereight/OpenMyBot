import { createHash } from "node:crypto";
import { collectRecallPassages, renderRecall, type RecallInput, type RecallPassage } from "./recall.ts";

export interface TrackedRecall {
  text: string;
  notes: number;
  conversations: number;
  commit: () => void;
}

export const EMPTY_TRACKED_RECALL: TrackedRecall = { text: "", notes: 0, conversations: 0, commit: () => {} };

export interface RecallLedgerOptions {
  maxScopes?: number;
  maxEntriesPerScope?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_SCOPES = 500;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 128;
const DEFAULT_TTL_MS = 30 * 60_000;

function scopeKey(threadId: string, botId: string): string {
  return `${threadId}\u0000${botId}`;
}

export function recallPassageFingerprint(passage: Pick<RecallPassage, "source" | "label" | "snippet">): string {
  const normalized = passage.snippet.replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(`${passage.source}\u0000${passage.label}\u0000${normalized}`)
    .digest("hex")
    .slice(0, 16);
}

export class RecallLedger {
  private readonly maxScopes: number;
  private readonly maxEntriesPerScope: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly scopes = new Map<string, Map<string, number>>();

  constructor(options: RecallLedgerOptions = {}) {
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
    this.maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private pruneExpired(entries: Map<string, number>, currentTime: number): void {
    const cutoff = currentTime - this.ttlMs;
    for (const [fingerprint, injectedAt] of entries) {
      if (injectedAt <= cutoff) entries.delete(fingerprint);
    }
  }

  filter(threadId: string, botId: string, passages: readonly RecallPassage[]): RecallPassage[] {
    if (!passages.length) return [];
    const key = scopeKey(threadId, botId);
    const entries = this.scopes.get(key);
    if (!entries) return [...passages];
    const currentTime = this.now();
    this.pruneExpired(entries, currentTime);
    if (!entries.size) {
      this.scopes.delete(key);
      return [...passages];
    }
    this.scopes.delete(key);
    this.scopes.set(key, entries);
    return passages.filter((passage) => !entries.has(recallPassageFingerprint(passage)));
  }

  record(threadId: string, botId: string, passages: readonly RecallPassage[]): void {
    if (!passages.length) return;
    const key = scopeKey(threadId, botId);
    const currentTime = this.now();
    const entries = this.scopes.get(key) ?? new Map<string, number>();
    this.pruneExpired(entries, currentTime);
    for (const passage of passages) {
      const fingerprint = recallPassageFingerprint(passage);
      entries.delete(fingerprint);
      entries.set(fingerprint, currentTime);
    }
    while (entries.size > this.maxEntriesPerScope) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    this.scopes.delete(key);
    this.scopes.set(key, entries);
    while (this.scopes.size > this.maxScopes) {
      const oldestScope = this.scopes.keys().next().value;
      if (oldestScope === undefined) break;
      this.scopes.delete(oldestScope);
    }
  }

  clear(threadId: string, botId: string): void {
    this.scopes.delete(scopeKey(threadId, botId));
  }

  clearThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of this.scopes.keys()) {
      if (key.startsWith(prefix)) this.scopes.delete(key);
    }
  }

  prepare(threadId: string, input: RecallInput, reset = false): TrackedRecall {
    if (reset) this.clear(threadId, input.botId);
    const fresh = this.filter(threadId, input.botId, collectRecallPassages(input));
    const rendered = renderRecall(fresh);
    if (!rendered) return EMPTY_TRACKED_RECALL;
    return {
      text: rendered.text,
      notes: rendered.notes,
      conversations: rendered.conversations,
      commit: () => this.record(threadId, input.botId, rendered.passages),
    };
  }
}
