// Guard for the fork's removal of plan billing (PR #2). Merging upstream/main has twice tried to bring plan billing back:
// upstream keeps real code at the paths this fork deleted or stubbed, so a merge either resurrects a deleted file or
// takes upstream's version of a stub. Neither shows up as a conflict that the build or the older tests would catch.
// This test fails when that happens. On a merge, keep the fork's side (delete the file, or keep the stub) and, if
// upstream adds a new purchase surface, add its path to REMOVED below.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buyOfferAllowed, cloudCreditLine, cloudPlanLine, cloudPlanView, cloudTrialView, moneyBackLine, offerTrialDays, trialRunning } from "./cloud-plan";
import { meterAmounts, meterPercent, resetLine } from "./usage-meter";
import { CloudCancelSheet, endedLine } from "../components/CloudCancelPlan";
import { ProCompareRow } from "../components/ProIntroduction";
import { MeterBar, UpgradeButton, useCloudUsageSettings } from "../components/CloudUsageMeter";

const ROOT = resolve(__dirname, "../..");

// Purchase, checkout, cancel and trial surfaces the fork deleted outright. None of them may come back.
const REMOVED = [
  "cancel-plan-preview.html",
  "cloud-buy-preview.html",
  "room-card-preview.html",
  "usage-meter-preview.html",
  "electron/cloud-plan-ipc.mjs",
  "electron/cloud-trial-notice.d.mts",
  "electron/cloud-trial-notice.mjs",
  "electron/cloud-trial-notice.node-test.mjs",
  "src/cancel-plan-preview.tsx",
  "src/cloud-buy-preview.tsx",
  "src/room-card-preview.tsx",
  "src/usage-meter-preview.tsx",
  "src/components/BoatOffer.tsx",
  "src/components/CloudAddDialog.tsx",
  "src/components/CloudTrialIntro.tsx",
  "src/components/CloudTrialNotice.tsx",
  "src/components/cloud-buy/AddCloudFlow.tsx",
  "src/components/cloud-buy/ChooseScreen.tsx",
  "src/components/cloud-buy/NewOrganization.tsx",
  "src/components/cloud-buy/NightCard.tsx",
  "src/components/cloud-buy/OneCloudScreen.tsx",
  "src/components/cloud-buy/PayScreen.tsx",
  "src/components/cloud-buy/SetupScreen.tsx",
];

describe("plan billing stays removed from this fork", () => {
  it.each(REMOVED)("%s is not back", (path) => {
    expect(existsSync(resolve(ROOT, path)), `${path} came back from a merge; delete it again`).toBe(false);
  });

  it("cloud-plan answers 'no plan, nothing to buy' for every account", () => {
    const accounts = [
      undefined,
      {},
      { status: "signed-out" },
      { status: "signed-in", plan: "pro", tier: "pro", paid: true },
      { status: "signed-in", trial: { daysLeft: 3 }, credit: { cents: 500 } },
    ];
    for (const account of accounts) {
      const view = cloudPlanView(account);
      expect(["signed-out", "removed"], JSON.stringify(account)).toContain(view.kind);
      expect(buyOfferAllowed(view)).toBe(false);
      expect(cloudPlanLine(view)).toBeNull();
    }
    // The one state this fork keeps is upstream's own sign-in one: a saved sign-in that could not be read.
    expect(cloudPlanView({ status: "signed-out", message: "restore-removed" }).kind).toBe("removed");
    expect(cloudTrialView({}, {})).toEqual({ title: "", body: "", action: { label: "" } });
    expect(cloudCreditLine({ cents: 500 })).toBe("");
    expect(moneyBackLine({} as never)).toBeNull();
    expect(offerTrialDays({ trialDays: 14 })).toBeNull();
    expect(trialRunning({ endsAt: Date.now() + 1e9 })).toBe(false);
  });

  it("no usage meter, upgrade button, cancel sheet or Pro pitch renders", () => {
    const meter = { used: 90, limit: 100 } as never;
    expect(meterPercent(meter)).toBe(0);
    expect(meterAmounts(meter)).toBe("");
    expect(resetLine({} as never)).toBe("");
    expect(MeterBar({ meter, label: "x" })).toBeNull();
    expect(UpgradeButton({ usage: {} as never, upgrade: useCloudUsageSettings().upgrade })).toBeNull();
    expect(CloudCancelSheet({ renewal: {} as never, actions: {} as never, onClose: () => {} })).toBeNull();
    expect(endedLine({} as never)).toBe("");
    expect(ProCompareRow()).toBeNull();
    const usage = useCloudUsageSettings();
    expect(usage.usage).toBeNull();
    expect(usage.dialog).toBeNull();
    expect(usage.upgrade.busy).toBeNull();
  });
});
