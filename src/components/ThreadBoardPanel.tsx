import { useEffect, useRef, useState } from "react";
import { ArrowUp, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCanWriteIn } from "@/lib/cloud-guest";
import { t } from "@/lib/i18n";
import { randomUuid } from "@/lib/random-uuid";
import { imeComposing, sendsMessage, useSendKey } from "@/lib/send-key";
import { localizedTaskTitle } from "@/lib/task-title";
import type { BoardCard, BoardColumn } from "@/lib/thread-board";
import { api, useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { BotAvatar } from "./Avatar";

/** How many of the newest messages the panel shows. */
export const PANEL_MESSAGES = 20;
const SENDING_REFRESH_MS = 2_000;

type Page = { messages?: Message[]; activeLeafId?: string | null };
type Pending = { sendId: string; text: string };

const said = (message: Message) => message.kind === "text" && Boolean(message.text?.trim());

/** The thread's newest messages: the open thread from the store, any other one fetched whenever the card changes. */
function useThreadMessages(card: BoardCard, bot: Bot | undefined, refreshing: boolean): Message[] | null {
  const open = bot !== undefined && bot.threadId === card.threadId;
  const [fetched, setFetched] = useState<Message[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(() => setTick((count) => count + 1), SENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshing]);
  useEffect(() => {
    if (open) return;
    let alive = true;
    void api<Page>(`/api/threads/${encodeURIComponent(card.threadId)}/messages?limit=${PANEL_MESSAGES}`, { background: true })
      .then((page) => { if (alive) setFetched(visibleMessages({ messages: page.messages ?? [], activeLeafId: page.activeLeafId ?? undefined })); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, card.threadId, card.at, tick]);
  return open ? visibleMessages(bot) : fetched;
}

/** Why the person cannot type here, or null when they can. */
function blockedNote(column: BoardColumn, card: BoardCard): string | null {
  if (column === "attention") return t("board.panel.needsYou");
  if (card.archived) return t("board.panel.archived");
  return null;
}

export function ThreadBoardPanel({ card, column, bot, onOpen, onClose }: {
  card: BoardCard;
  column: BoardColumn;
  bot: Bot | undefined;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const sendKey = useSendKey();
  const canWrite = useCanWriteIn(card.threadId, bot?.yourAccess);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const messages = useThreadMessages(card, bot, pending.length > 0);
  const shown = (messages ?? []).filter(said).slice(-PANEL_MESSAGES);
  const waiting = pending.filter((entry) => !(messages ?? []).some((message) => message.sendId === entry.sendId));
  const note = blockedNote(column, card);
  const canType = note === null && canWrite === true && bot !== undefined;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [shown.length, waiting.length]);

  const send = () => {
    const message = text.trim();
    if (!message || !canType) return;
    const sendId = randomUuid();
    setPending((current) => [...current, { sendId, text: message }]);
    setText("");
    dispatch({
      type: "send", botId: card.botId, threadId: card.threadId, text: message, sendId,
      onError: () => {
        setPending((current) => current.filter((entry) => entry.sendId !== sendId));
        setText((draft) => draft || message);
      },
    });
  };

  return (
    <aside data-board-panel={card.threadId} aria-label={localizedTaskTitle(card.title) || t("task.untitledChat")}
      className="flex w-[380px] max-w-[45%] shrink-0 flex-col border-l border-hairline/40 bg-panel/40">
      <header className="flex shrink-0 items-start gap-2 border-b border-hairline/40 px-4 py-3">
        {bot && <BotAvatar bot={bot} size={24} motion="none" motionKey={0} animated={false} />}
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-[13px] font-semibold text-ink">{localizedTaskTitle(card.title) || t("task.untitledChat")}</h2>
          <p className="truncate text-[11px] text-ink-secondary">{card.botName}</p>
        </div>
        <button type="button" data-board-panel-open onClick={onOpen} aria-label={t("board.panel.openChat")} title={t("board.panel.openChat")}
          className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"><ExternalLink size={14} aria-hidden="true" /></button>
        <button type="button" data-board-panel-close onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
          className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"><X size={14} aria-hidden="true" /></button>
      </header>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {messages !== null && shown.length === 0 && waiting.length === 0 && <p className="py-6 text-center text-[12px] text-ink-secondary">{t("board.panel.empty")}</p>}
        {shown.map((message) => (
          <p key={message.id} data-board-message={message.role} dir="auto"
            className={cn("max-w-[90%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] leading-5", message.role === "user" ? "self-end bg-accent/15 text-ink" : "self-start bg-card text-ink")}>
            {message.text}
          </p>
        ))}
        {waiting.map((entry) => (
          <p key={entry.sendId} data-board-message="pending" dir="auto" className="max-w-[90%] self-end whitespace-pre-wrap break-words rounded-2xl bg-accent/10 px-3 py-2 text-[13px] leading-5 text-ink-secondary">
            {entry.text}<span className="ms-2 text-[11px]">{t("board.panel.sending")}</span>
          </p>
        ))}
      </div>
      <footer className="shrink-0 border-t border-hairline/40 p-3">
        {note && <p data-board-panel-note className="mb-2 text-[12px] text-ink-secondary">{note}</p>}
        {!note && card.locked && <p className="mb-2 text-[11px] text-ink-secondary">{t("board.panel.queueHint")}</p>}
        <div className="flex items-end gap-2 rounded-2xl bg-composer px-3 py-2 ring-1 ring-composer-ring">
          <textarea rows={1} dir="auto" value={text} disabled={!canType} aria-label={t("board.panel.placeholder", { name: card.botName })}
            placeholder={t("board.panel.placeholder", { name: card.botName })}
            className="block max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-[14px] leading-6 placeholder:text-ink-secondary focus:outline-none disabled:opacity-50"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (imeComposing(event.nativeEvent)) return;
              if (sendsMessage(event.nativeEvent, sendKey)) { event.preventDefault(); send(); }
            }} />
          <button type="button" data-board-panel-send onClick={send} disabled={!canType || text.trim() === ""} aria-label={t("board.panel.send")}
            className={cn("mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-white transition-opacity", canType && text.trim() ? "bg-accent hover:brightness-110" : "bg-ink-secondary/30")}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </div>
      </footer>
    </aside>
  );
}
