// Plan billing is removed from this fork: no Cloud usage meters exist. Keeps the names upstream imports.
import type { CloudUsage, CloudUsageMeter } from "../../electron/cloud-home.mjs";

export const meterPercent = (_meter: CloudUsageMeter): number => 0;
export const meterAmounts = (_meter: CloudUsageMeter): string => "";
export const meterLabel = (kind: string): string => kind;
export const resetLine = (_usage: CloudUsage): string => "";
