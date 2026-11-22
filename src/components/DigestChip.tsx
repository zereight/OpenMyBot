import { useState } from "react";
import { BookMarked, ClipboardList, RotateCcw } from "lucide-react";

import { t } from "@/lib/i18n";
import { memoInLocale } from "@/lib/locale-memo";
import { fileLabel, revertMemoryChange } from "@/lib/memory";
import type { LocaleKey } from "@/locales";
import { formatDuration } from "@/lib/usage-trace";
import type { Message } from "@/state/store";
import { traceRootId } from "../../shared/usage-trace";
import { EXCERPT_SUMMARY_HEADER } from "../../shared/wire";
import { TraceDialog } from "./lazy-screens";

const WORK_KEY: Record<"noFiles" | "oneFile" | "files", Record<"oneTool" | "tools", LocaleKey>> = {
  noFiles: { oneTool: "chat.digestChipNoFilesOne", tools: "chat.digestChipNoFiles" },
  oneFile: { oneTool: "chat.digestChipOneEach", tools: "chat.digestChipOneFile" },
  files: { oneTool: "chat.digestChipOneTool", tools: "chat.digestChip" },
};
const one = (count: number | string) => String(count) === "1";

export function MemoryReceipt({ message }: { message: Message }) {
  const [reverted, setReverted] = useState<ReadonlySet<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const digest = message.digest;
  if (!digest?.memory.length) return null;
  const { botId, memory, memoryDropped: dropped } = digest;

  const undo = async (journalId: string) => {
    if (busyId || reverted.has(journalId)) return;
    setBusyId(journalId);
    setError(null);
    try {
      await revertMemoryChange(botId, journalId);
      setReverted((prev) => new Set([...prev, journalId]));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("chat.memoryReceipt.revertFailed"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="memory-receipt">
      {memory.map((item, index) => {
        const key = item.journalId ?? `${item.path}:${index}`;
        const delta = [
          item.added ? `+${item.added}` : null,
          item.removed ? `-${item.removed}` : null,
        ].filter(Boolean).join("/");
        const isRestored = item.via === "deletion-guard";
        const isUndone = Boolean(item.journalId && reverted.has(item.journalId));
        return (
          <span key={key} data-memory-receipt-item={item.path}
            className="ui-chip max-w-[min(420px,100%)] border border-hairline/40 bg-panel text-ink-secondary">
            <BookMarked size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{fileLabel(item.path)}</span>
            {isRestored && <span className="rounded bg-warning/15 px-1 text-[11px] font-medium text-warning">{t("chat.memoryReceipt.restored")}</span>}
            {!isRestored && delta && <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary/80">{delta}</span>}
            {item.journalId && item.canRevert && (
              isUndone ? (
                <span className="shrink-0 text-[11px] text-ink-secondary/70" data-memory-reverted={item.journalId}>{t("chat.memoryReceipt.reverted")}</span>
              ) : (
                <button type="button" disabled={busyId !== null} onClick={() => void undo(item.journalId!)}
                  data-memory-revert={item.journalId}
                  className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-accent hover:underline disabled:opacity-50">
                  <RotateCcw size={10} aria-hidden="true" />
                  {busyId === item.journalId ? t("memory.undoing") : t("memory.undo")}
                </button>
              )
            )}
          </span>
        );
      })}
      {Boolean(dropped && dropped > 0) && (
        <span className="text-[11px] text-ink-secondary/80">{t("chat.run.more", { count: dropped! })}</span>
      )}
      {error && <span role="alert" className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}

export const DigestChip = memoInLocale(function DigestChip({ message }: { message: Message }) {
  const [tracing, setTracing] = useState(false);
  const digest = message.digest;
  if (!digest) return null;
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length + (digest.files.truncated ?? 0) : null;
  const worked = digest.tools.length || digest.toolCalls || digest.toolsDropped || files || digest.memory.length || digest.memoryDropped;
  const tools = digest.toolCalls ?? `${digest.tools.reduce((n, tool) => n + tool.count, 0)}${digest.toolsDropped ? "+" : ""}`;
  const label = [
    digest.durationMs > 0 ? t("trace.workedFor", { duration: formatDuration(digest.durationMs) }) : null,
    worked ? t(WORK_KEY[files === null ? "noFiles" : one(files) ? "oneFile" : "files"][one(tools) ? "oneTool" : "tools"], { tools, files: files ?? 0 }) : null,
  ].filter(Boolean).join(" · ");
  if (!label) return null;
  return (
    <div className="flex flex-col items-start gap-1" data-testid="digest-chip">
      <span
        title={message.text ?? t("chat.digestTitle")}
        className="ui-chip max-w-[min(520px,100%)] border border-hairline/40 bg-panel text-ink-secondary"
      >
        <ClipboardList size={12} />
        <span className="truncate">{label}</span>
        <button type="button" onClick={() => setTracing(true)} className="shrink-0 text-accent hover:underline" data-testid="view-trace">
          {t("trace.view")}
        </button>
      </span>
      <MemoryReceipt message={message} />
      {tracing && <TraceDialog id={traceRootId(digest.threadId, digest.turnId)} at={digest.at} onClose={() => setTracing(false)} />}
    </div>
  );
});

const COMPACTION_CHIP = "max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary";

export function CompactionChip({ message, onNewChat }: { message: Message; onNewChat?: () => void }) {
  if (message.compaction?.fresh) {
    return (
      <div role="separator" data-testid="fresh-start-divider" className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-secondary">
        <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
        <span className="text-center"><span className="font-medium">{t("chat.startFresh.divider")}</span> · {t("chat.startFresh.dividerHint")}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
      </div>
    );
  }
  const excerpts = message.compaction?.summary.startsWith(EXCERPT_SUMMARY_HEADER);
  const chip = message.compaction ? (
    <details className={COMPACTION_CHIP} data-testid="compaction-chip">
      <summary className="cursor-pointer font-medium">{t(excerpts ? "chat.compactionExcerptTitle" : "chat.compactionTitle")}</summary>
      <p className="mt-2">{t(excerpts ? "chat.compactionExcerptHint" : "chat.compactionHint")}</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{message.compaction.summary}</p>
    </details>
  ) : message.engineCompaction ? (
    <div className={COMPACTION_CHIP} data-testid="engine-compaction-chip">
      <p className="font-medium">{t("chat.engineCompactionTitle")}</p>
      <p className="mt-1">{t("chat.engineCompactionHint")}</p>
    </div>
  ) : null;
  if (!chip || !onNewChat) return chip;
  return (
    <div>
      {chip}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 px-3 text-[12px] text-ink-secondary" data-testid="new-chat-hint">
        {t("chat.newChatHint")}
        <button type="button" onClick={onNewChat} className="font-medium text-accent hover:underline">{t("chat.newChatHintButton")}</button>
      </p>
    </div>
  );
}
