import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { MAX_SUGGESTIONS_PER_TURN, type SuggestionItem, type SuggestionStatus } from "../shared/suggestions.ts";
import { writeFileAtomic } from "./atomic.ts";
import { recordsBlock } from "./records-block.ts";
import { redactSecretsInText } from "./redact.ts";

export const SUGGESTIONS_FILE = "look-around-suggestions.json";
const MAX_STORED = 200;
const MAX_HISTORY_LINES = 40;
const MAX_TITLE = 160;
const MAX_SUMMARY = 500;
const MAX_PROMPT = 1_000;
const MAX_LINK = 500;

const statusSchema = z.enum(["open", "accepted", "dismissed"]);
const itemSchema = z.object({
  id: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  botName: z.string().min(1).max(128),
  title: z.string().min(1).max(MAX_TITLE),
  summary: z.string().max(MAX_SUMMARY),
  prompt: z.string().min(1).max(MAX_PROMPT),
  link: z.string().max(MAX_LINK).optional(),
  status: statusSchema,
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  acceptedThreadId: z.string().min(1).max(128).optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  items: z.array(itemSchema).max(MAX_STORED),
});

export interface NewSuggestionInput {
  title: string;
  summary?: string;
  prompt?: string;
  link?: string;
}

export type AddSuggestionResult =
  | { ok: true; item: SuggestionItem }
  | { ok: false; reason: "turn_cap" | "duplicate" | "invalid" };

const oneLine = (text: string, max: number): string =>
  redactSecretsInText(text).replace(/\s+/g, " ").trim().slice(0, max);

const safeLink = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const trimmed = raw.trim().slice(0, MAX_LINK);
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const redacted = redactSecretsInText(parsed.toString());
    if (redacted !== parsed.toString()) return undefined;
    return redacted.slice(0, MAX_LINK);
  } catch {
    return undefined;
  }
};

const normKey = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

export interface SuggestionsStoreDeps {
  dataDir: string;
  now?: () => number;
  maxPerTurn?: number;
}

export function createSuggestionsStore(deps: SuggestionsStoreDeps) {
  const now = deps.now ?? Date.now;
  const maxPerTurn = deps.maxPerTurn ?? MAX_SUGGESTIONS_PER_TURN;
  const file = join(deps.dataDir, SUGGESTIONS_FILE);
  let items: SuggestionItem[] = [];
  const turnCounts = new Map<string, number>();

  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) items = parsed.data.items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`suggestions: ${file} is unreadable; starting fresh`);
    }
  }

  const save = () => {
    items = items.slice(0, MAX_STORED);
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, items })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`suggestions: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  function list(filter?: { botId?: string; status?: SuggestionStatus }): SuggestionItem[] {
    return items
      .filter((item) => (!filter?.botId || item.botId === filter.botId) && (!filter?.status || item.status === filter.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function get(id: string): SuggestionItem | null {
    return items.find((item) => item.id === id) ?? null;
  }

  function addFromTurn(
    turnId: string,
    bot: { id: string; name: string },
    input: NewSuggestionInput,
  ): AddSuggestionResult {
    const used = turnCounts.get(turnId) ?? 0;
    if (used >= maxPerTurn) return { ok: false, reason: "turn_cap" };

    const title = oneLine(input.title, MAX_TITLE);
    if (!title) return { ok: false, reason: "invalid" };
    const summary = oneLine(input.summary ?? "", MAX_SUMMARY);
    const prompt = oneLine(input.prompt ?? "", MAX_PROMPT) || title;
    const link = safeLink(input.link);

    const titleKey = normKey(title);
    const linkKey = link ? normKey(link) : null;
    const duplicate = items.some((existing) =>
      existing.botId === bot.id
      && existing.status === "open"
      && (normKey(existing.title) === titleKey || (linkKey !== null && existing.link !== undefined && normKey(existing.link) === linkKey)),
    );
    if (duplicate) return { ok: false, reason: "duplicate" };

    const at = now();
    const item: SuggestionItem = {
      id: randomUUID(),
      botId: bot.id,
      botName: oneLine(bot.name, 128) || bot.id,
      title,
      summary,
      prompt,
      ...(link ? { link } : {}),
      status: "open",
      createdAt: at,
      updatedAt: at,
    };
    items = [item, ...items].slice(0, MAX_STORED);
    turnCounts.set(turnId, used + 1);
    if (turnCounts.size > 200) {
      const oldest = turnCounts.keys().next().value;
      if (oldest !== undefined) turnCounts.delete(oldest);
    }
    save();
    return { ok: true, item };
  }

  function accept(id: string, threadId?: string): SuggestionItem | null {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = items[index]!;
    const updated: SuggestionItem = {
      ...current,
      status: "accepted",
      updatedAt: now(),
      ...(threadId ? { acceptedThreadId: threadId } : {}),
    };
    items = [...items.slice(0, index), updated, ...items.slice(index + 1)];
    save();
    return updated;
  }

  function dismiss(id: string): SuggestionItem | null {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = items[index]!;
    const updated: SuggestionItem = {
      ...current,
      status: "dismissed",
      updatedAt: now(),
    };
    items = [...items.slice(0, index), updated, ...items.slice(index + 1)];
    save();
    return updated;
  }

  /** Previous suggestions for a bot's next look-around prompt: ONLY title, status, and link,
   * each secret-redacted and fenced as untrusted records so old items cannot steer the turn. */
  function historyRecords(botId: string, limit = MAX_HISTORY_LINES): string | null {
    const recent = list({ botId }).slice(0, limit);
    if (!recent.length) return null;
    const lines = recent.map((item) => {
      const parts = [
        `status=${item.status}`,
        `title=${redactSecretsInText(item.title)}`,
        ...(item.link ? [`link=${redactSecretsInText(item.link)}`] : []),
      ];
      return `- ${parts.join(" | ")}`;
    });
    return recordsBlock("previous look-around suggestions", lines);
  }

  return { list, get, addFromTurn, accept, dismiss, historyRecords };
}

export type SuggestionsStore = ReturnType<typeof createSuggestionsStore>;
