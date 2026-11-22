import { ExternalLink, Loader2, Play, Sparkles, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { closeInbox } from "@/state/inbox";
import { openThread } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { useStoreSelector } from "@/state/store-select";
import { acceptSuggestion, dismissSuggestion, triggerLookAround, useSuggestionsState } from "@/state/suggestions";

export function SuggestionsSection() {
  const { suggestions, lookAround, busyId, error } = useSuggestionsState();
  const store = useStoreRef();
  const showThreads = useShowThreads();
  const phone = useMediaQuery(PHONE_LAYOUT);
  const targetBotId = useStoreSelector((state) => {
    const visible = state.bots.filter((bot) => !bot.hidden && !bot.movedTo);
    if (state.selectedId && visible.some((bot) => bot.id === state.selectedId)) return state.selectedId;
    return visible.find((bot) => bot.defaultBot)?.id ?? visible[0]?.id ?? null;
  });

  if (!targetBotId && suggestions.length === 0) return null;

  const onLookAround = () => {
    if (!targetBotId || lookAround.running) return;
    void triggerLookAround(targetBotId);
  };

  const onAccept = async (id: string) => {
    const opened = await acceptSuggestion(id);
    if (opened) {
      openThread(store.dispatch, opened, store.state(), showThreads);
      if (phone) closeInbox();
    }
  };

  return (
    <section data-inbox-suggestions className="mx-2 mb-2 mt-1 rounded-xl border border-hairline/60 bg-raised/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles size={13} aria-hidden="true" className="shrink-0 text-accent" />
          <h3 className="truncate text-[12px] font-semibold text-ink">{t("inbox.suggestions.title")}</h3>
          {suggestions.length > 0 && (
            <span className="rounded-full bg-ink/[0.08] px-1.5 py-px text-[11px] font-medium tabular-nums text-ink-secondary">
              {suggestions.length}
            </span>
          )}
        </div>
        {targetBotId && (
          <button
            type="button"
            data-look-around-button
            disabled={lookAround.running}
            onClick={onLookAround}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/70 bg-panel px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-60"
          >
            {lookAround.running && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
            <span>{lookAround.running ? t("inbox.suggestions.lookingAround") : t("inbox.suggestions.lookAround")}</span>
          </button>
        )}
      </div>
      {error && (
        <p data-suggestions-error className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <ul data-suggestions-list className="mt-2 space-y-1.5">
          {suggestions.map((item) => {
            const busy = busyId === item.id;
            return (
              <li key={item.id} data-suggestion-id={item.id} className="rounded-lg border border-hairline/50 bg-panel/80 px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink">{item.title}</p>
                    {item.summary && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{item.summary}</p>}
                    {item.link && (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex max-w-full items-center gap-1 text-[11px] text-accent hover:underline"
                      >
                        <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
                        <span className="truncate">{item.link}</span>
                      </a>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      data-suggestion-accept={item.id}
                      disabled={busy}
                      onClick={() => void onAccept(item.id)}
                      title={t("inbox.suggestions.start")}
                      aria-label={t("inbox.suggestions.start")}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      <Play size={11} aria-hidden="true" />
                      <span>{t("inbox.suggestions.start")}</span>
                    </button>
                    <button
                      type="button"
                      data-suggestion-dismiss={item.id}
                      disabled={busy}
                      onClick={() => void dismissSuggestion(item.id)}
                      title={t("inbox.suggestions.dismiss")}
                      aria-label={t("inbox.suggestions.dismiss")}
                      className="inline-flex size-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink disabled:opacity-50"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
