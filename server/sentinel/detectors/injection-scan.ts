// Tool output is untrusted text. A phrase in it that tries to steer the bot is worth seeing, nothing more:
// this records the sighting and never blocks, rewrites or hides the call.
import { holdsCredential } from "../../../shared/redact.ts";
import { capTitle, signatureOf } from "../normalize.ts";
import type { Detector, Observation } from "../types.ts";

/** Lowercased, so the SQL prefilter and this check agree. A match is a sighting, not proof. */
export const INJECTION_NEEDLES: readonly string[] = [
  "ignore previous instructions",
  "ignore all previous",
  "disregard previous instructions",
  "disregard all previous",
  "you are now",
  "new instructions",
  "system prompt",
];

const NEEDLE = new RegExp(INJECTION_NEEDLES.map((needle) => needle.replace(/ /g, "\\s+")).join("|"), "i");

export const injectionScan: Detector = {
  name: "injection_scan",
  detect(records) {
    const observations: Observation[] = [];
    for (const record of records) {
      if (record.type !== "tool" || !record.ok || !NEEDLE.test(record.text)) continue;
      // A credential store is not instructions. The same rule shared/redact.ts uses for tool titles.
      if (holdsCredential(record.text)) continue;
      const matched = NEEDLE.exec(record.text)?.[0] ?? "";
      NEEDLE.lastIndex = 0;
      observations.push({
        kind: "injection_scan",
        signature: signatureOf("injection_scan", record.tool),
        title: capTitle(`tool output contains "${matched.toLowerCase().replace(/\s+/g, " ")}"`),
        origin: "external",
        severity: "medium",
        tool: record.tool,
        threadId: record.threadId,
        at: record.at,
        occurrence: `tool:${record.id}`,
        evidence: { source: "messages", id: record.id },
        ...(record.botId ? { botId: record.botId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
      });
    }
    return observations;
  },
};
