// Plan billing is removed from this fork: there is no plan to cancel. Keeps the names upstream imports.
import type { CloudCancelSurvey, CloudRenewalResult } from "../../electron/cloud-account.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";

export interface CloudRenewalActions {
  cancel(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keep(): Promise<CloudRenewalResult>;
}

export const endedLine = (_renewal: CloudRenewal): string => "";
export function CloudCancelSheet(_props: { renewal: CloudRenewal; actions: CloudRenewalActions; onClose: (changed: boolean) => void }) { return null; }
