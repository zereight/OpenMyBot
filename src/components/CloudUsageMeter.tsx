// Plan billing is removed from this fork: no Cloud usage to meter or upgrade. Keeps the names upstream imports.
import type { ReactNode } from "react";
import type { CloudUsage, CloudUsageMeter } from "../../electron/cloud-home.mjs";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SIMPLE_CARD } from "./SettingsPrimitives";

export type UpgradeUi = { busy: "preview" | "change" | null; note: { tone: "good" | "info" | "bad"; text: string } | null; onUpgrade: (tier?: string) => void };

export function MeterBar(_props: { meter: CloudUsageMeter; label: string; compact?: boolean }) { return null; }
export function UpgradeButton(_props: { usage: CloudUsage; upgrade: UpgradeUi; className?: string; secondary?: boolean }) { return null; }
export function useCloudUsageSettings(): { usage: CloudUsage | null; upgrade: UpgradeUi; dialog: ReactNode } {
  return { usage: null, upgrade: { busy: null, note: null, onUpgrade: () => {} }, dialog: null };
}

type MeterBand = "ok" | "near" | "full";
const meterBand = (percent: number): MeterBand => percent >= 100 ? "full" : percent >= 80 ? "near" : "ok";
const SUMMARY_BAR: Record<MeterBand, string> = { ok: "bg-ink/80", near: "bg-warning", full: "bg-danger" };

/** The percent-used card: PlanUsage still shows its own engine allowances in it. */
export function UsageSummaryCard({ kind, title, percent, label, note, children }: {
  kind: "cloud" | "plan"; title: string; percent: number; label: string; note: ReactNode; children?: ReactNode;
}) {
  const band = meterBand(percent);
  return (
    <section data-usage-summary={kind} data-band={band} aria-label={label} className={cn(SIMPLE_CARD, "px-4 py-3.5")}>
      <p className="text-[13px] leading-[18px] text-ink">{title}</p>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[22px] font-medium leading-7 tracking-[-0.012em] text-ink tabular-nums">{percent}%</span>
        <span className="text-[13px] text-ink-secondary">{t("settings.simple.billing.used")}</span>
      </p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink/[0.04]">
        <div className={cn("h-full rounded-full", SUMMARY_BAR[band])} style={{ width: `${percent > 0 ? Math.max(percent, 1) : 0}%` }} />
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-secondary">{note}</p>
      {children}
    </section>
  );
}
