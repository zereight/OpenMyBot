import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BOARD_COLUMNS, buildThreadBoard, type BoardCard, type BoardColumn } from "@/lib/thread-board";
import { localizedTaskTitle } from "@/lib/task-title";
import { useShowThreads } from "@/lib/thread-preferences";
import { openThread } from "@/state/thread-navigation";
import { setMapView, useMapView, type MapView } from "@/lib/map-view";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { Select } from "./Select";
import { threadUpdatedLabel, useRelativeNow } from "./SidebarThreadRow";

/** A long column shows this many cards until the person asks for the rest. */
export const BOARD_CARDS_SHOWN = 25;

const COLUMN_TONE: Record<BoardColumn, string> = {
  attention: "bg-warning",
  working: "bg-success",
  teammates: "bg-accent",
  idle: "bg-ink-secondary/50",
  done: "bg-ink-secondary/25",
};

function Card({ card, bot, now, onOpen }: { card: BoardCard; bot: Bot | undefined; now: number; onOpen: (card: BoardCard) => void }) {
  return (
    <button type="button" data-board-card={card.threadId} onClick={() => onOpen(card)}
      className="flex w-full flex-col gap-1.5 rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-left transition hover:bg-raised/50">
      <span className="line-clamp-2 text-[13px] font-medium text-ink">{localizedTaskTitle(card.title) || t("task.untitledChat")}</span>
      <span className="flex items-center gap-2 text-[11px] text-ink-secondary">
        {bot && <BotAvatar bot={bot} size={16} motion="none" motionKey={0} animated={false} />}
        <span className="min-w-0 flex-1 truncate">{card.botName}</span>
        {card.stalled && <span className="rounded-full bg-danger/15 px-1.5 py-0.5 font-medium text-danger">{t("board.stalled")}</span>}
        {card.unread && <span aria-label={t("board.unread")} className="size-1.5 shrink-0 rounded-full bg-accent" />}
        {card.at > 0 && <span className="shrink-0">{threadUpdatedLabel(card.at, now)}</span>}
      </span>
    </button>
  );
}

function Column({ column, cards, bots, now, onOpen }: { column: BoardColumn; cards: BoardCard[]; bots: Map<string, Bot>; now: number; onOpen: (card: BoardCard) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? cards : cards.slice(0, BOARD_CARDS_SHOWN);
  return (
    <section data-board-column={column} aria-label={t(`board.column.${column}`)} className="flex w-64 shrink-0 flex-col rounded-2xl bg-panel/60 p-2">
      <h2 className="flex items-center gap-2 px-2 py-1.5 text-[12px] font-semibold text-ink">
        <span aria-hidden className={cn("size-2 rounded-full", COLUMN_TONE[column])} />
        <span className="flex-1 truncate">{t(`board.column.${column}`)}</span>
        <span className="text-ink-secondary">{cards.length}</span>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {shown.length === 0 && <p className="px-2 py-4 text-center text-[12px] text-ink-secondary">{t("board.empty")}</p>}
        {shown.map((card) => <Card key={`${card.botId}:${card.threadId}`} card={card} bot={bots.get(card.botId)} now={now} onOpen={onOpen} />)}
        {!all && cards.length > shown.length && (
          <button type="button" onClick={() => setAll(true)} className="rounded-lg px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
            {t("board.showMore", { count: cards.length - shown.length })}
          </button>
        )}
      </div>
    </section>
  );
}

export function ThreadBoard({ bots, teams }: { bots: Bot[]; teams: Array<{ key: string; name: string }> }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const now = useRelativeNow();
  const [team, setTeam] = useState<string | null>(null);
  const scoped = useMemo(() => team === null ? bots : bots.filter((bot) => (bot.section?.trim() ?? "") === team), [bots, team]);
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const board = useMemo(() => buildThreadBoard(scoped, now, state.pendingQueued), [scoped, now, state.pendingQueued]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {teams.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 px-6 pt-4 text-[12px] text-ink-secondary">
          <label htmlFor="board-team">{t("board.team")}</label>
          <Select id="board-team" size="sm" value={team ?? ""} onChange={(event) => setTeam(event.target.value === "" ? null : event.target.value)}>
            <option value="">{t("board.allTeams")}</option>
            {teams.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
          </Select>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-6">
        {BOARD_COLUMNS.map((column) => (
          <Column key={column} column={column} cards={board[column]} bots={byId} now={now}
            onOpen={(card) => openThread(dispatch, { botId: card.botId, threadId: card.threadId }, state, showThreads)} />
        ))}
      </div>
    </div>
  );
}

export function MapViewToggle() {
  const current = useMapView();
  const option = (value: MapView, label: string) => (
    <button type="button" aria-pressed={current === value} onClick={() => setMapView(value)}
      className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium", current === value ? "bg-panel text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{label}</button>
  );
  return (
    <div role="group" aria-label={t("canvas.title")} className="flex items-center gap-0.5 rounded-lg bg-control p-0.5">
      {option("map", t("canvas.view.map"))}{option("board", t("canvas.view.board"))}
    </div>
  );
}
