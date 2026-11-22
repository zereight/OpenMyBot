export type SuggestionStatus = "open" | "accepted" | "dismissed";

export const MAX_SUGGESTIONS_PER_TURN = 5;

export interface SuggestionItem {
  id: string;
  botId: string;
  botName: string;
  title: string;
  summary: string;
  prompt: string;
  link?: string;
  status: SuggestionStatus;
  createdAt: number;
  updatedAt: number;
  acceptedThreadId?: string;
}

export interface LookAroundRunStatus {
  running: boolean;
  botId?: string;
  startedAt?: number;
  lastFinishedAt?: number;
  lastError?: string;
  lastCount?: number;
}

export interface SuggestionsResponse {
  suggestions: SuggestionItem[];
  lookAround: LookAroundRunStatus;
}
