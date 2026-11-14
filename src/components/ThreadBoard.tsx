import { useMemo, useState } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BOARD_COLUMNS, buildThreadBoard, type BoardCard, type BoardColumn, type ThreadBoard as ThreadBoardColumns } from "@/lib/thread-board";
import { localizedTaskTitle } from "@/lib/task-title";
import { useShowThreads } from "@/lib/thread-preferences";
import { openThread } from "@/state/thread-navigation";
import { setMapView, useMapView, type MapView } from "@/lib/map-view";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { Select } from "./Select";
import { ThreadBoardPanel } from "./ThreadBoardPanel";
import { threadRowActions, threadUpdatedLabel, useRelativeNow } from "./SidebarThreadRow";

/** A long column shows this many cards until the person asks for the rest. */
export const BOARD_CARDS_SHOWN = 25;

const cardKey = (card: { botId: string; threadId: string }) => `${card.botId}:${card.threadId}`;

const COLUMN_TONE: Record<BoardColumn, string> = {
  attention: "bg-warning",
  working: "bg-success",
  teammates: "bg-accent",
  idle: "bg-ink-secondary/50",
  done: "bg-ink-secondary/25",
  archived: "bg-ink-secondary/15",
};

/** The threads of one team; `name` is null on the plain single board, which has no team heading. */
interface BoardLane { key: string; name: string | null; bots: Bot[] }

interface CardActions {
  selected: { botId: string; threadId: string } | null;
  onOpen: (card: BoardCard) => void;
  onArchive: (card: BoardCard) => void;
  onDelete: (card: BoardCard) => void;
}

const ACTION_CLS = "flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-secondary";

function Card({ card, bot, now, actions }: { card: BoardCard; bot: Bot | undefined; now: number; actions: CardActions }) {
  const editable = bot?.yourAccess !== "view";
  const selected = actions.selected?.botId === card.botId && actions.selected.threadId === card.threadId;
  const archiveLabel = card.archived ? t("task.unarchive") : t("task.archive");
  return (
    <div className="group/card relative">
      <button type="button" data-board-card={card.threadId} aria-pressed={selected} onClick={() => actions.onOpen(card)}
        className={cn("flex w-full flex-col gap-1.5 rounded-xl border bg-card px-3 py-2.5 text-left transition hover:bg-raised/50", selected ? "border-accent/60 ring-1 ring-accent/40" : "border-hairline/40")}>
        <span className="line-clamp-2 text-[13px] font-medium text-ink">{localizedTaskTitle(card.title) || t("task.untitledChat")}</span>
        <span className="flex items-center gap-2 text-[11px] text-ink-secondary">
          {bot && <BotAvatar bot={bot} size={16} motion="none" motionKey={0} animated={false} />}
          <span className="min-w-0 flex-1 truncate">{card.botName}</span>
          {card.stalled && <span className="rounded-full bg-danger/15 px-1.5 py-0.5 font-medium text-danger">{t("board.stalled")}</span>}
          {card.unread && <span aria-label={t("board.unread")} className="size-1.5 shrink-0 rounded-full bg-accent" />}
          {card.at > 0 && <span className="shrink-0">{threadUpdatedLabel(card.at, now)}</span>}
        </span>
      </button>
      {editable && (
        <div className="absolute right-1.5 top-1.5 flex gap-0.5 rounded-lg bg-card/95 opacity-0 shadow-sm ring-1 ring-hairline/40 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
          <button type="button" data-board-archive={card.threadId} disabled={card.locked} aria-label={archiveLabel} title={archiveLabel}
            onClick={() => actions.onArchive(card)} className={ACTION_CLS}>
            {card.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
          </button>
          <button type="button" data-board-delete={card.threadId} disabled={card.locked} aria-label={t("task.deleteAria")} title={t("task.deleteAria")}
            onClick={() => actions.onDelete(card)} className={cn(ACTION_CLS, "hover:text-danger")}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

function Column({ column, cards, bots, now, actions, capped }: { column: BoardColumn; cards: BoardCard[]; bots: Map<string, Bot>; now: number; actions: CardActions; capped?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? cards : cards.slice(0, BOARD_CARDS_SHOWN);
  return (
    <section data-board-column={column} aria-label={t(`board.column.${column}`)} className="flex w-64 shrink-0 flex-col rounded-2xl bg-panel/60 p-2">
      <h2 className="flex items-center gap-2 px-2 py-1.5 text-[12px] font-semibold text-ink">
        <span aria-hidden className={cn("size-2 rounded-full", COLUMN_TONE[column])} />
        <span className="flex-1 truncate">{t(`board.column.${column}`)}</span>
        <span className="text-ink-secondary">{cards.length}</span>
      </h2>
      <div className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto", capped && "max-h-80")}>
        {shown.length === 0 && <p className="px-2 py-4 text-center text-[12px] text-ink-secondary">{t("board.empty")}</p>}
        {shown.map((card) => <Card key={cardKey(card)} card={card} bot={bots.get(card.botId)} now={now} actions={actions} />)}
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
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  // A deleted thread leaves the board at once; the server's answer follows a moment later, and a refused delete brings it back.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  // One team picked: a single board. "All teams": one lane per team, so the columns are never a mix of teams.
  const lanes = useMemo<BoardLane[]>(() => {
    const sectionOf = (bot: Bot) => bot.section?.trim() ?? "";
    if (team !== null) return [{ key: team, name: null, bots: bots.filter((bot) => sectionOf(bot) === team) }];
    if (teams.length <= 1) return [{ key: "", name: null, bots }];
    const known = new Set(teams.map((entry) => entry.key));
    const strays = [...new Set(bots.map(sectionOf).filter((key) => !known.has(key)))].map((key) => ({ key, name: key }));
    return [...teams, ...strays]
      .map((entry) => ({ key: entry.key, name: entry.name, bots: bots.filter((bot) => sectionOf(bot) === entry.key) }))
      .filter((lane) => lane.bots.length > 0);
  }, [bots, team, teams]);
  const laneBoards = useMemo(() => lanes.map((lane) => {
    const built = buildThreadBoard(lane.bots, now, state.pendingQueued);
    if (removed.size === 0) return built;
    return Object.fromEntries(BOARD_COLUMNS.map((column) => [column, built[column].filter((card) => !removed.has(cardKey(card)))])) as ThreadBoardColumns;
  }), [lanes, now, state.pendingQueued, removed]);
  const everyCard = laneBoards.flatMap((board) => BOARD_COLUMNS.map((column) => ({ column, cards: board[column] })).flatMap(({ column, cards }) => cards.map((card) => ({ card, column, siblings: cards }))));
  const [deleting, setDeleting] = useState<{ botId: string; threadId: string } | null>(null);
  // The open dialog follows the board, so a thread that started working or went away since it was asked about is not deleted.
  const doomed = deleting ? everyCard.find(({ card }) => card.botId === deleting.botId && card.threadId === deleting.threadId)?.card : undefined;
  const wide = useMediaQuery(SIDEBAR_INLINE, true);
  const [selected, setSelected] = useState<{ botId: string; threadId: string } | null>(null);
  const open = (card: BoardCard) => openThread(dispatch, { botId: card.botId, threadId: card.threadId }, state, showThreads);
  // Looked up on every render: a thread that was deleted, snoozed or ended since closes the panel instead of leaving a stale copy.
  const chosen = wide && selected
    ? everyCard.find(({ card }) => card.botId === selected.botId && card.threadId === selected.threadId)
    : undefined;
  const remove = (card: BoardCard) => {
    const key = cardKey(card);
    // The panel moves to the card beside the deleted one, so deleting a run of threads does not keep closing it.
    if (chosen && cardKey(chosen.card) === key) {
      const column = chosen.siblings;
      const index = column.findIndex((entry) => cardKey(entry) === key);
      const next = column[index + 1] ?? column[index - 1];
      setSelected(next ? { botId: next.botId, threadId: next.threadId } : null);
    }
    setRemoved((current) => new Set(current).add(key));
    dispatch({
      type: "deleteTask", botId: card.botId, threadId: card.threadId,
      onError: () => setRemoved((current) => { const rest = new Set(current); rest.delete(key); return rest; }),
    });
  };
  const actions: CardActions = {
    selected: chosen ? selected : null,
    onOpen: (card) => (wide ? setSelected({ botId: card.botId, threadId: card.threadId }) : open(card)),
    onArchive: (card) => threadRowActions(card.botId, dispatch, false).onArchive(card, card.archived ? null : Date.now()),
    onDelete: (card) => setDeleting({ botId: card.botId, threadId: card.threadId }),
  };
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
      <div className="flex min-h-0 flex-1">
        {lanes[0]?.name === null || lanes.length === 0 ? (
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-6">
            {BOARD_COLUMNS.map((column) => (
              <Column key={column} column={column} cards={laneBoards[0]?.[column] ?? []} bots={byId} now={now} actions={actions} />
            ))}
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-auto p-6">
            {lanes.map((lane, index) => {
              const laneBoard = laneBoards[index]!;
              const total = BOARD_COLUMNS.reduce((sum, column) => sum + laneBoard[column].length, 0);
              return (
                <section key={lane.key} data-board-team={lane.key} aria-label={lane.name!} className="flex w-max min-w-full flex-col gap-2">
                  <h2 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <span className="truncate">{lane.name}</span>
                    <span className="text-[12px] font-normal text-ink-secondary">{total}</span>
                  </h2>
                  <div className="flex gap-3">
                    {BOARD_COLUMNS.map((column) => (
                      <Column key={column} column={column} cards={laneBoard[column]} bots={byId} now={now} actions={actions} capped />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {chosen && <ThreadBoardPanel key={cardKey(chosen.card)} card={chosen.card} column={chosen.column} bot={byId.get(chosen.card.botId)}
          onOpen={() => open(chosen.card)} onClose={() => setSelected(null)} />}
      </div>
      <ConfirmDialog open={doomed !== undefined} title={t("task.deleteConfirm")}
        body={t("task.deleteBody", { title: localizedTaskTitle(doomed?.title ?? "") || t("task.untitledChat") })} confirmLabel={t("task.deleteAria")}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (doomed && !doomed.locked) remove(doomed);
          setDeleting(null);
        }} />
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
