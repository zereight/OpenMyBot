import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { Notification, NotifyKind } from "../../shared/notification.ts";
import type { PersonWait } from "../../shared/person-wait.ts";
import { NEEDS_YOU_WINDOW_MS } from "../../shared/today.ts";
import { writeFileAtomic } from "../atomic.ts";
import { DEFAULT_QUESTION_NUDGE_MINUTES, threadQuestionNudgeMs, type AppConfig } from "../config.ts";
import { buildNotification } from "../notify.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { Store } from "../store.ts";

export const QUESTION_NUDGES_FILE = "question-nudges.json";
const MAX_NUDGED = 2_000;
const POLL_INTERVAL_MS = 60_000;

const fileSchema = z.object({
  version: z.literal(1),
  nudged: z.record(z.string().min(1).max(512), z.number().finite()),
});

export interface QuestionNudgeDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "groupByThread" | "taskByThread">;
  waiting: () => Array<PersonWait & { threadId: string; botId: string }>;
  busy: (botId: string, threadId: string) => boolean;
  delayMs: () => number | null;
  notify: (notification: Notification | null) => void;
  now?: () => number;
  intervalMs?: number;
}

export interface NudgedQuestion {
  threadId: string;
  botId: string;
  messageId: string;
  kind: PersonWait["kind"];
}

function notifyKindFor(kind: PersonWait["kind"]): NotifyKind {
  switch (kind) {
    case "password": return "secret";
    case "sign-in":
    case "connect": return "sign-in";
    case "question": return "question";
    default: return "approval";
  }
}

export function questionNudgeStatus(cfg: AppConfig): { questionNudge: boolean; questionNudgeMinutes: number } {
  const ms = threadQuestionNudgeMs(cfg);
  return { questionNudge: ms !== null, questionNudgeMinutes: ms !== null ? Math.round(ms / 60_000) : DEFAULT_QUESTION_NUDGE_MINUTES };
}

export function createQuestionNudge(deps: QuestionNudgeDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const file = join(deps.dataDir, QUESTION_NUDGES_FILE);
  const nudged = new Map<string, number>();

  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) {
      for (const [messageId, at] of Object.entries(parsed.data.nudged)) nudged.set(messageId, at);
    }
  } catch {
  }

  function pruneAndPersist(at: number): void {
    const cutoff = at - NEEDS_YOU_WINDOW_MS;
    for (const [messageId, nudgedAt] of nudged) {
      if (nudgedAt < cutoff) nudged.delete(messageId);
    }
    if (nudged.size > MAX_NUDGED) {
      const oldest = [...nudged.entries()].sort((left, right) => left[1] - right[1]);
      for (const [messageId] of oldest.slice(0, nudged.size - MAX_NUDGED)) nudged.delete(messageId);
    }
    mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ version: 1, nudged: Object.fromEntries(nudged) }, null, 2)}\n`, { mode: 0o600 });
  }

  function buildNudge(wait: PersonWait & { threadId: string; botId: string }): Notification | null {
    const bot = store.bot(wait.botId);
    if (!bot) return null;
    const group = store.groupByThread(wait.threadId);
    if (!group) {
      const task = store.taskByThread(bot.id, wait.threadId);
      if (task?.archivedAt) return null;
    }
    const language = conversationLanguage(wait.threadId);
    const detail = wait.label.trim();
    const body = detail
      ? serverLine(language, "server.notify.stillWaiting", { detail })
      : serverLine(language, "server.notify.stillWaitingFallback");
    const extra = {
      avatarUrl: bot.avatarUrl,
      ...(group ? { group: { id: group.id, name: group.name } } : {}),
      ...(wait.kind === "password" ? { label: wait.label } : {}),
      ...(wait.kind === "sign-in" ? { site: wait.label } : {}),
      ...(wait.kind === "connect" ? { app: wait.label } : {}),
    };
    return buildNotification(notifyKindFor(wait.kind), { ...bot, threadId: wait.threadId }, wait.threadId, body, extra);
  }

  function sweep(at = now()): { nudged: NudgedQuestion[] } {
    const delayMs = deps.delayMs();
    if (delayMs === null || delayMs <= 0) return { nudged: [] };
    const sent: NudgedQuestion[] = [];
    let dirty = false;

    for (const wait of deps.waiting()) {
      const elapsed = at - wait.at;
      if (elapsed < delayMs || elapsed >= NEEDS_YOU_WINDOW_MS) continue;
      if (nudged.has(wait.messageId)) continue;
      if (deps.busy(wait.botId, wait.threadId)) continue;

      const notification = buildNudge(wait);
      if (!notification) continue;
      nudged.set(wait.messageId, at);
      dirty = true;
      deps.notify(notification);
      sent.push({ threadId: wait.threadId, botId: wait.botId, messageId: wait.messageId, kind: wait.kind });
    }

    if (dirty) pruneAndPersist(at);
    return { nudged: sent };
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    sweep,
    start(): void {
      if (timer) return;
      timer = setInterval(() => { sweep(); }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export type QuestionNudge = ReturnType<typeof createQuestionNudge>;
