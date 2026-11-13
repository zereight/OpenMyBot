// Plan billing is removed from this fork. This module keeps the names the rest of the app still imports, and every
// one of them answers "no plan, nothing to buy". Upstream keeps real code at this path: keep it as a stub on merges.
import type { CloudOffer } from "../../electron/cloud-home.mjs";

export type CloudPlanView = { kind: "unknown" | "signed-out" | "paid" | "free" | "attention" | "purchase" | "unverified" | "reauth" | "removed"; label: string; trial?: boolean; checking?: boolean; paidAt?: number; reason?: string };

const PLAN_LABEL: Record<string, string> = { starter: "Starter", personal: "Personal", pro: "Pro", max: "Max" };

export function cloudPlanLabel(tier?: string): string { return tier === undefined ? "Pro" : PLAN_LABEL[tier] ?? "Cloud"; }
export function cloudPlanView(_account: unknown): CloudPlanView { return { kind: "signed-out", label: "" }; }
export function cloudPlanLine(_view: CloudPlanView): string | null { return null; }
export function buyOfferAllowed(_view: CloudPlanView): boolean { return false; }
export function cloudTrialView(_trial: unknown, _credit?: unknown): { title: string; body: string; action: { label: string } } { return { title: "", body: "", action: { label: "" } }; }
export function cloudCreditLine(_credit: unknown): string { return ""; }
export function moneyBackLine(_offer: CloudOffer | null | undefined): string | null { return null; }
export function offerTrialDays(_offer: unknown): null { return null; }
export function trialRunning(_trial: unknown): boolean { return false; }
