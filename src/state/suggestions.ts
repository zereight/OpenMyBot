import { useEffect, useSyncExternalStore } from "react";
import type { LookAroundRunStatus, SuggestionItem, SuggestionsResponse } from "../../shared/suggestions";
import { api } from "./api";

export interface SuggestionsState {
  suggestions: SuggestionItem[];
  lookAround: LookAroundRunStatus;
  busyId: string | null;
  error: string | null;
}

const INITIAL: SuggestionsState = {
  suggestions: [],
  lookAround: { running: false },
  busyId: null,
  error: null,
};

let current: SuggestionsState = INITIAL;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const update = (patch: Partial<SuggestionsState>) => {
  current = { ...current, ...patch };
  emit();
};

export const useSuggestionsState = (): SuggestionsState =>
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => current);

export function setSuggestionsState(next: Partial<SuggestionsState>): void {
  current = { ...INITIAL, ...next };
  emit();
}

let inFlight: Promise<void> | null = null;
export function refreshSuggestions(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await api<SuggestionsResponse>("/api/suggestions?status=open");
      if (data && Array.isArray(data.suggestions)) {
        update({ suggestions: data.suggestions, lookAround: data.lookAround ?? { running: false }, error: null });
      }
    } catch {
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function useSuggestionsLoader(active: boolean): void {
  const { lookAround } = useSuggestionsState();
  useEffect(() => {
    if (!active) return;
    void refreshSuggestions();
  }, [active]);
  useEffect(() => {
    if (!active || !lookAround.running) return;
    const timer = setInterval(() => { void refreshSuggestions(); }, 3_000);
    return () => clearInterval(timer);
  }, [active, lookAround.running]);
}

export async function triggerLookAround(botId: string): Promise<boolean> {
  update({ lookAround: { ...current.lookAround, running: true, botId }, error: null });
  try {
    const res = await api<{ ok: boolean; lookAround?: LookAroundRunStatus }>(`/api/bots/${encodeURIComponent(botId)}/look-around`, { method: "POST" });
    update({ lookAround: res.lookAround ?? { running: true, botId } });
    return true;
  } catch (error) {
    update({
      lookAround: { ...current.lookAround, running: false },
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function acceptSuggestion(id: string): Promise<{ botId: string; threadId: string } | null> {
  update({ busyId: id, error: null });
  try {
    const res = await api<{ ok: boolean; botId?: string; threadId?: string }>(`/api/suggestions/${encodeURIComponent(id)}/accept`, { method: "POST" });
    update({ suggestions: current.suggestions.filter((item) => item.id !== id), busyId: null });
    return res.botId && res.threadId ? { botId: res.botId, threadId: res.threadId } : null;
  } catch (error) {
    update({ busyId: null, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function dismissSuggestion(id: string): Promise<boolean> {
  update({ busyId: id, error: null });
  try {
    await api(`/api/suggestions/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    update({ suggestions: current.suggestions.filter((item) => item.id !== id), busyId: null });
    return true;
  } catch (error) {
    update({ busyId: null, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
