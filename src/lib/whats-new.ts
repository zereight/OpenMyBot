import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { track } from "@/lib/analytics";
import { WHATS_NEW_NOTICE } from "@/lib/notices";

export type WhatsNewSlide = "pro" | "team";
/** Who the account is to MausBot Cloud: no plan, a plan of its own, in a team, or something else (being bought, needing
 * attention, not checked). Null until the sign-in is restored and checked. */
export type WhatsNewAudience = "none" | "own" | "team" | "other";

/** Each slide's tag on the Cloud's funnel: `src` on its links, and `source` on the checkout the app opens from it. */
export const WHATS_NEW_SOURCES = { pro: "app_whats_new_pro", team: "app_whats_new_team" } as const satisfies Record<WhatsNewSlide, string>;
const CLOUD_SITE = "https://cloud.openmausbot.com", STAGING_SITE = "https://omb-cloud-staging.fly.dev";

/** The Cloud website's Home, which shows the plans to someone without one; `src` on /cloud opens that page. */
export const newCloudUrl = (staging = false) => `${staging ? STAGING_SITE : CLOUD_SITE}/cloud?src=${WHATS_NEW_SOURCES.pro}`;
/** The Team plan's checkout, as the website's Get Team opens it: its free trial while the Admin offers one. */
export const startTeamUrl = (staging = false) => `${staging ? STAGING_SITE : CLOUD_SITE}/pro/buy?plan=team&src=${WHATS_NEW_SOURCES.team}`;

const listedCloud = (account: CloudAccountState, team: boolean) =>
  (account.clouds ?? []).some(cloud => cloud.managed !== false && cloud.status !== "ended" && (cloud.teamId !== null) === team);

const CLOUD_TEAM_TIERS = ["team", "business"] as const;
function trialRunning(trial: { state?: string } | undefined): boolean {
  return trial?.state === "active" || trial?.state === "ending" || trial?.state === "processing";
}
export function whatsNewAudience(account: CloudAccountState | null): WhatsNewAudience | null {
  if (!account) return null;
  if (account.status === "signed-out" && account.message === "restoring") return null;
  if (account.status === "signed-out" && account.message !== "restore-removed") return "none";
  if (account.status === "connecting") return null;
  if (account.status !== "connected") return "other";
  if (account.teams?.length || CLOUD_TEAM_TIERS.includes(account.entitlement?.tier as "team" | "business") || listedCloud(account, true)) return "team";
  if (account.entitlement?.plan === "pro" && account.entitlement.status === "active") return "own";
  if (account.purchase || account.entitlement?.plan === "pro" || account.machine || account.checkout || account.adding || trialRunning(account.trial) || listedCloud(account, false)) return "other";
  return "none";
}

/** No plan: the new Cloud, then Team. A plan of one's own: Team. Anyone in a team, or not known: nothing. */
export function whatsNewSlides(audience: WhatsNewAudience | null): WhatsNewSlide[] {
  return audience === "none" ? ["pro", "team"] : audience === "own" ? ["team"] : [];
}

export interface WhatsNewView {
  slides: WhatsNewSlide[];
  audience: "none" | "own";
  signedIn: boolean;
  staging: boolean;
  /** Each slide's plan in the Admin's words: its name, and its price line. */
  plans: Partial<Record<WhatsNewSlide, { name: string; terms: string }>>;
}

/** "loading" while the account or the offer is read; "none" when nothing is for this account now (a later launch may say
 * otherwise). A slide whose plan the Admin doesn't offer is left out. */
export function whatsNewView(account: CloudAccountState | null, offer: CloudOffer | null | undefined): WhatsNewView | "loading" | "none" {
  const audience = whatsNewAudience(account);
  if (audience === null) return "loading";
  if (audience !== "none" && audience !== "own") return "none";
  if (offer === undefined) return "loading";
  return "none";
}

export type WhatsNewAction = "seen" | "next" | "back" | "get_pro" | "see_cloud" | "start_team" | "not_now" | "close";

export function reportWhatsNew(action: WhatsNewAction, slide: WhatsNewSlide, view: Pick<WhatsNewView, "audience" | "signedIn">) {
  track("whats_new", { action, slide, audience: view.audience === "own" ? "own_plan" : "no_plan", signed_in: view.signedIn, campaign: WHATS_NEW_NOTICE });
}
