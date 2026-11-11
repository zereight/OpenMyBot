import { brandStatus } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { localDesktopPage } from "./onboarding/WelcomeGate";

export type SchedulePlace = { kind: "cloud" } | { kind: "server" } | { kind: "local"; next: "add-cloud" | "open-cloud" | null };

export function schedulePlace({ cloudHome, local, plan, ready, offersAllowed }: {
  cloudHome: boolean; local: boolean; plan: unknown; ready: boolean; offersAllowed: boolean;
}): SchedulePlace {
  void plan; void ready; void offersAllowed;
  if (cloudHome) return { kind: "cloud" };
  if (!local) return { kind: "server" };
  return { kind: "local", next: null };
}

export function RoutineScheduleNote() {
  const { state } = useStore();
  const local = localDesktopPage() && window.ogb?.remoteClient?.active !== true;
  const place = schedulePlace({ cloudHome: state.config?.cloudHome === true, local, plan: null,
    ready: false, offersAllowed: brandStatus().source !== "file" });
  const link = "text-left underline underline-offset-2 hover:text-ink";
  const openCloud = () => { if (window.confirm(t("routines.scheduleNote.leave"))) void window.ogb?.cloudAccount?.connectHome().catch(() => {}); };
  return <p data-routine-schedule-note={place.kind === "local" ? place.next ?? "local" : place.kind} className="text-[11px] leading-relaxed text-ink-secondary">
    {place.kind === "cloud" ? t("routines.scheduleNote.cloud") : place.kind === "server" ? t("routines.scheduleNote.server") : <>
      {t("routines.scheduleNote.local")}
      {place.next === "add-cloud" && <> <button type="button" className={link} onClick={openCloud}>{t("routines.scheduleNote.addCloud")}</button></>}
      {place.next === "open-cloud" && <> {t("routines.scheduleNote.openCloud")} <button type="button" className={link} onClick={openCloud}>{t("cloudHome.connect")}</button></>}
    </>}
  </p>;
}
