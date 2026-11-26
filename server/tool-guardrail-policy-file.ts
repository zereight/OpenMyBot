import { readFileSync } from "node:fs";

import { activeToolGuardrails, parseToolGuardrails, type ToolGuardrailRule } from "../shared/tool-guardrails.ts";

export interface GuardrailPolicy {
  rules: ToolGuardrailRule[];
  protectedPaths: string[];
}

type LoadedGuardrailPolicy = { ok: true; policy: GuardrailPolicy } | { ok: false; error: string };

export function readGuardrailPolicyFile(path: string): LoadedGuardrailPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, error: "Guardrail policy file could not be read." };
  }
  const { rules, protectedPaths } = (raw ?? {}) as { rules?: unknown; protectedPaths?: unknown };
  const parsed = parseToolGuardrails(rules);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.rules || activeToolGuardrails(parsed.rules).length === 0) return { ok: false, error: "Guardrail policy file has no active rules." };
  if (!Array.isArray(protectedPaths) || !protectedPaths.every((path) => typeof path === "string")) {
    return { ok: false, error: "Guardrail policy file has invalid protected paths." };
  }
  return { ok: true, policy: { rules: parsed.rules, protectedPaths } };
}
