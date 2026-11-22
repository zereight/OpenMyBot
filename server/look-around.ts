import { randomUUID } from "node:crypto";
import { z } from "zod";

import { MAX_SUGGESTIONS_PER_TURN, type LookAroundRunStatus, type SuggestionItem } from "../shared/suggestions.ts";
import type { HostTurnResult } from "./coordinator.ts";
import type { BotRecord, Message } from "./store.ts";
import type { NewSuggestionInput, SuggestionsStore } from "./suggestions.ts";

const LOOK_AROUND_MAX_MS = 10 * 60 * 1_000;

const rawSuggestionSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  prompt: z.string().optional(),
  link: z.string().optional(),
});

export function buildLookAroundPrompt(options: {
  botName: string;
  historyBlock: string | null;
  maxSuggestions?: number;
}): string {
  const max = options.maxSuggestions ?? MAX_SUGGESTIONS_PER_TURN;
  const parts = [
    `Take a quick read-only look around for the user (recent conversations and any connected Gmail or Google Calendar).`,
    `Do not send messages, create drafts, modify files, or take external actions.`,
    `Find up to ${max} concrete, high-value follow-up tasks the user might want ${options.botName} to start next.`,
    `If nothing genuinely needs attention, return an empty JSON array [].`,
  ];
  if (options.historyBlock) {
    parts.push(
      `Do not repeat items that were already suggested, accepted, or dismissed in the history below:`,
      options.historyBlock,
    );
  }
  parts.push(
    `Reply with a single \`\`\`json code block containing a JSON array of at most ${max} objects with keys:`,
    `- "title": short action title (<= 120 chars)`,
    `- "summary": 1-2 sentence explanation of why this matters now`,
    `- "prompt": the instruction to run if the user accepts this suggestion`,
    `- "link": optional https URL to the relevant item (omit if none)`,
  );
  return parts.join("\n\n");
}

export function parseLookAroundSuggestions(text: string, max = MAX_SUGGESTIONS_PER_TURN): NewSuggestionInput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates: string[] = [];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const body = fenced[i]?.[1]?.trim();
    if (body) candidates.push(body);
  }
  candidates.push(trimmed);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
        ? (parsed as { suggestions: unknown[] }).suggestions
        : null);
    if (!list) continue;
    const out: NewSuggestionInput[] = [];
    for (const entry of list) {
      if (out.length >= max) break;
      const checked = rawSuggestionSchema.safeParse(entry);
      if (checked.success) out.push(checked.data);
    }
    return out;
  }
  return [];
}

export interface LookAroundDeps {
  suggestions: SuggestionsStore;
  bot(botId: string): Pick<BotRecord, "id" | "name"> | null | undefined;
  createThread(botId: string, title: string): string | undefined;
  activePath(threadId: string): readonly Message[];
  startTurn(
    botId: string,
    prompt: string,
    opts: { threadId: string; unattended: true; cardContinuation: true; onSettled: (outcome: HostTurnResult) => void },
  ): Promise<unknown>;
  now?: () => number;
  maxPerTurn?: number;
  onChanged?: () => void;
}

export type StartLookAroundResult =
  | { ok: true; threadId: string; startedAt: number }
  | { ok: false; reason: "not_found" | "already_running" | "failed"; error?: string };

export function createLookAround(deps: LookAroundDeps) {
  const now = deps.now ?? Date.now;
  const maxPerTurn = deps.maxPerTurn ?? MAX_SUGGESTIONS_PER_TURN;
  const confinedThreads = new Set<string>();
  let activeRun: { botId: string; threadId: string; turnKey: string; startedAt: number } | null = null;
  let lastFinishedAt: number | undefined;
  let lastError: string | undefined;
  let lastCount: number | undefined;

  const clearExpired = () => {
    if (activeRun && now() - activeRun.startedAt > LOOK_AROUND_MAX_MS) {
      activeRun = null;
      lastFinishedAt = now();
      lastError = "Look-around timed out.";
    }
  };

  /** Every look-around thread stays confined by read-and-draft.ts, finished or not. */
  const confines = (threadId: string): boolean => confinedThreads.has(threadId);

  function status(): LookAroundRunStatus {
    clearExpired();
    return {
      running: activeRun !== null,
      ...(activeRun ? { botId: activeRun.botId, startedAt: activeRun.startedAt } : {}),
      ...(lastFinishedAt !== undefined ? { lastFinishedAt } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(lastCount !== undefined ? { lastCount } : {}),
    };
  }

  function settle(bot: Pick<BotRecord, "id" | "name">, threadId: string, turnKey: string, startedAt: number, outcome: HostTurnResult): SuggestionItem[] {
    if (activeRun?.turnKey === turnKey) activeRun = null;
    lastFinishedAt = now();
    if (!outcome.ok) {
      lastError = "Look-around turn failed.";
      lastCount = 0;
      deps.onChanged?.();
      return [];
    }
    const botText = deps.activePath(threadId)
      .filter((message) => message.role === "bot" && message.kind === "text" && message.at >= startedAt && Boolean(message.text?.trim()))
      .map((message) => message.text)
      .join("\n\n");
    const parsed = parseLookAroundSuggestions(botText, maxPerTurn);
    const added: SuggestionItem[] = [];
    for (const item of parsed) {
      const result = deps.suggestions.addFromTurn(turnKey, bot, item);
      if (result.ok) added.push(result.item);
      else if (result.reason === "turn_cap") break;
    }
    lastError = undefined;
    lastCount = added.length;
    deps.onChanged?.();
    return added;
  }

  async function start(botId: string): Promise<StartLookAroundResult> {
    clearExpired();
    if (activeRun) return { ok: false, reason: "already_running", error: "A look-around is already running." };
    const bot = deps.bot(botId);
    if (!bot) return { ok: false, reason: "not_found", error: "Bot not found." };
    const threadId = deps.createThread(bot.id, "Look around");
    if (!threadId) return { ok: false, reason: "failed", error: "Could not create look-around thread." };

    confinedThreads.add(threadId);
    const startedAt = now();
    const turnKey = randomUUID();
    activeRun = { botId: bot.id, threadId, turnKey, startedAt };
    lastError = undefined;
    deps.onChanged?.();

    const historyBlock = deps.suggestions.historyRecords(bot.id);
    const prompt = buildLookAroundPrompt({ botName: bot.name, historyBlock, maxSuggestions: maxPerTurn });

    try {
      await deps.startTurn(bot.id, prompt, {
        threadId,
        unattended: true,
        cardContinuation: true,
        onSettled: (outcome) => { settle(bot, threadId, turnKey, startedAt, outcome); },
      });
      return { ok: true, threadId, startedAt };
    } catch (error) {
      if (activeRun?.turnKey === turnKey) activeRun = null;
      lastFinishedAt = now();
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      lastCount = 0;
      deps.onChanged?.();
      return { ok: false, reason: "failed", error: message };
    }
  }

  return { confines, status, start };
}

export type LookAround = ReturnType<typeof createLookAround>;
