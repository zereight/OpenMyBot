export interface MemoryEvalCase {
  id: string;
  category: string;
  description: string;
  memoryMd: string;
  topics: Record<string, string>;
  generateTopics?: number;
  generateFixTopics?: number;
  query?: string;
  promptOpts?: {
    managedWrites?: boolean;
    fileTools?: boolean;
    writesRefused?: boolean;
  };
  expectRecallContain?: string[];
  expectRecallAbsent?: string[];
  expectPromptContain?: string[];
  expectPromptAbsent?: string[];
  maxIndexChars?: number;
}

export interface MemoryEvalObservation {
  recallText: string;
  promptText: string;
  indexChars: number;
}

export interface MemoryCaseResult {
  id: string;
  category: string;
  passed: boolean;
  failures: string[];
  promptBytes: number;
  indexChars: number;
}

export interface MemoryEvalReport {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgPromptBytes: number;
  results: MemoryCaseResult[];
}

export interface MemoryEvalComparison {
  adopted: boolean;
  basePassed: number;
  candidatePassed: number;
  regressions: string[];
  improvements: string[];
  promptBytesDelta: number;
  maxPromptDelta: number;
  reasons: string[];
}

export function scoreCase(spec: MemoryEvalCase, obs: MemoryEvalObservation): MemoryCaseResult {
  const failures: string[] = [];
  for (const needle of spec.expectRecallContain ?? []) {
    if (!obs.recallText.includes(needle)) failures.push(`recall missing ${JSON.stringify(needle)}`);
  }
  for (const forbidden of spec.expectRecallAbsent ?? []) {
    if (obs.recallText.includes(forbidden)) failures.push(`recall unexpectedly contained ${JSON.stringify(forbidden)}`);
  }
  for (const needle of spec.expectPromptContain ?? []) {
    if (!obs.promptText.includes(needle)) failures.push(`prompt missing ${JSON.stringify(needle)}`);
  }
  for (const forbidden of spec.expectPromptAbsent ?? []) {
    if (obs.promptText.includes(forbidden)) failures.push(`prompt unexpectedly contained ${JSON.stringify(forbidden)}`);
  }
  if (spec.maxIndexChars !== undefined && obs.indexChars > spec.maxIndexChars) {
    failures.push(`topic index ${obs.indexChars} chars exceeded cap ${spec.maxIndexChars}`);
  }
  return {
    id: spec.id,
    category: spec.category,
    passed: failures.length === 0,
    failures,
    promptBytes: Buffer.byteLength(obs.promptText, "utf8"),
    indexChars: obs.indexChars,
  };
}

export function summarize(results: readonly MemoryCaseResult[]): MemoryEvalReport {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const avgPromptBytes = total
    ? Math.round(results.reduce((sum, r) => sum + r.promptBytes, 0) / total)
    : 0;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total ? Number((passed / total).toFixed(4)) : 0,
    avgPromptBytes,
    results: [...results],
  };
}

/** Adoption gate: candidate must not regress any passing case, must score >= base, and must stay within prompt budget. */
export function compareReports(
  base: MemoryEvalReport,
  candidate: MemoryEvalReport,
  maxPromptDelta = 800,
): MemoryEvalComparison {
  const baseById = new Map(base.results.map((r) => [r.id, r]));
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const item of candidate.results) {
    const prev = baseById.get(item.id);
    if (!prev) continue;
    if (prev.passed && !item.passed) regressions.push(item.id);
    if (!prev.passed && item.passed) improvements.push(item.id);
  }
  const promptBytesDelta = candidate.avgPromptBytes - base.avgPromptBytes;
  const reasons: string[] = [];
  if (regressions.length > 0) reasons.push(`pass->fail regressions: ${regressions.join(", ")}`);
  if (candidate.passed < base.passed) reasons.push(`passed count dropped (${base.passed} -> ${candidate.passed})`);
  if (promptBytesDelta > maxPromptDelta) {
    reasons.push(`avg prompt bytes grew by +${promptBytesDelta} (max +${maxPromptDelta})`);
  }
  return {
    adopted: reasons.length === 0,
    basePassed: base.passed,
    candidatePassed: candidate.passed,
    regressions,
    improvements,
    promptBytesDelta,
    maxPromptDelta,
    reasons,
  };
}
