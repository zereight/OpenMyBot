// Codex owns history; this receipt only remembers which bot rules and which
// volatile context digest the native thread last carried.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CodexInstructionReceipt {
  instructions: string;
  volatile?: string;
  turnsSinceVolatile?: number;
  compactionStreak?: number;
  volatileCooldownTurns?: number;
}

export const CODEX_VOLATILE_RE_ANCHOR_TURNS = 8;
export const CODEX_VOLATILE_COOLDOWN_BASE = 2;

const isFingerprint = (value: string) => /^[0-9a-f]{64}$/.test(value);
const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function receiptPath(key: string, nativeThreadId: string): { directory: string; path: string } {
  const directory = join(DATA_DIR, "codex-instructions");
  return { directory, path: join(directory, `${digest(JSON.stringify([key, nativeThreadId]))}.sha256`) };
}

function parseReceipt(raw: string | undefined): CodexInstructionReceipt | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isFingerprint(trimmed)) return { instructions: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as {
        instructions?: unknown;
        volatile?: unknown;
        turnsSinceVolatile?: unknown;
        compactionStreak?: unknown;
        volatileCooldownTurns?: unknown;
      };
      if (typeof record.instructions === "string" && isFingerprint(record.instructions)) {
        return {
          instructions: record.instructions,
          ...(typeof record.volatile === "string" && isFingerprint(record.volatile) ? { volatile: record.volatile } : {}),
          ...(isNonNegativeInt(record.turnsSinceVolatile) ? { turnsSinceVolatile: record.turnsSinceVolatile } : {}),
          ...(isNonNegativeInt(record.compactionStreak) && record.compactionStreak > 0 ? { compactionStreak: record.compactionStreak } : {}),
          ...(isNonNegativeInt(record.volatileCooldownTurns) && record.volatileCooldownTurns > 0 ? { volatileCooldownTurns: record.volatileCooldownTurns } : {}),
        };
      }
    }
  } catch {}
  return null;
}

export function invalidateCodexVolatile(
  key: string,
  nativeThreadId: string,
  options: { deliveredVolatile?: boolean } = {},
): void {
  const { directory, path } = receiptPath(key, nativeThreadId);
  let previous: CodexInstructionReceipt | null;
  try {
    previous = parseReceipt(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  if (!previous) return;
  if (options.deliveredVolatile) {
    const streak = (previous.compactionStreak ?? 0) + 1;
    const cooldown = Math.min(CODEX_VOLATILE_RE_ANCHOR_TURNS, CODEX_VOLATILE_COOLDOWN_BASE * (2 ** (streak - 1)));
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(
      path,
      JSON.stringify({ instructions: previous.instructions, compactionStreak: streak, volatileCooldownTurns: cooldown }),
      { mode: 0o600 },
    );
    return;
  }
  if (previous.volatileCooldownTurns && previous.volatileCooldownTurns > 0) return;
  if (previous.volatile === undefined && previous.turnsSinceVolatile === undefined && !previous.compactionStreak) return;
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(path, JSON.stringify({ instructions: previous.instructions }), { mode: 0o600 });
}

/** Preserve native configured rules when overriding Codex's developer slot. */
export function codexDeveloperInstructions(config: unknown, botInstructions: string): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Codex returned no effective configuration; cannot safely update bot instructions.");
  }
  const configured = (config as Record<string, unknown>).developer_instructions;
  if (configured != null && typeof configured !== "string") {
    throw new Error("Codex returned invalid developer instructions; cannot safely update bot instructions.");
  }
  // Native rules go last, keeping their precedence over the bot's.
  return configured
    ? `${botInstructions || "No OpenMyBot bot-specific instructions remain."}\n\n${configured}`
    : botInstructions;
}

export async function syncCodexInstructions(
  key: string,
  nativeThreadId: string,
  instructions: string,
  volatile: string,
  resumed: boolean,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  mentionTurn = false,
  reAnchorAfterTurns = 0,
): Promise<{ deliverVolatile: boolean; hadVolatile: boolean; commitVolatile: (() => void) | null }> {
  const { directory, path } = receiptPath(key, nativeThreadId);
  const fingerprint = digest(instructions);
  const volatileFingerprint = digest(volatile);
  let previous: CodexInstructionReceipt | null;
  try {
    previous = parseReceipt(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    previous = null;
  }
  if (resumed && previous?.instructions !== fingerprint) {
    // Codex 0.153.4 keeps the old initial developer message until compaction, so an update is appended
    // only on change. inject_items flushes history before acknowledging; only then is the receipt written.
    try {
      await request("thread/inject_items", {
        threadId: nativeThreadId,
        items: [{
          type: "message",
          role: "developer",
          content: [{
            type: "input_text",
            text: "The following replaces the previous developer instruction block supplied by OpenMyBot, including its native configured rules and bot-specific instructions. Other Codex instructions and permissions still apply.\n\n"
              + (instructions || "No OpenMyBot bot-specific instructions remain."),
          }],
        }],
      });
    } catch (error) {
      if (error instanceof Error && /method not found|unknown method/i.test(error.message)) {
        throw new Error(`This Codex version cannot update bot instructions in a resumed session. Update Codex and retry: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  const hasVolatile = Boolean(volatile.trim());
  const turnsSinceVolatile = typeof previous?.turnsSinceVolatile === "number" ? previous.turnsSinceVolatile : 0;
  const cooldown = previous?.volatileCooldownTurns ?? 0;
  const cooldownActive = resumed && !mentionTurn && hasVolatile && cooldown > 0;
  const reAnchor = reAnchorAfterTurns > 0 && resumed && hasVolatile && previous?.volatile === volatileFingerprint && turnsSinceVolatile >= reAnchorAfterTurns;
  const deliverVolatile = cooldownActive ? false : (!resumed || previous?.volatile !== volatileFingerprint || mentionTurn || reAnchor);
  const hadVolatile = typeof previous?.volatile === "string" && previous.volatile !== digest("");
  if (!resumed || previous?.instructions !== fingerprint) {
    // The volatile digest stays pending until the provider accepts the turn, so a rejected one redelivers.
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(path, JSON.stringify({ instructions: fingerprint }), { mode: 0o600 });
  }
  if (cooldownActive) {
    const remaining = cooldown - 1;
    const streak = previous?.compactionStreak ?? 0;
    return {
      deliverVolatile: false,
      hadVolatile,
      commitVolatile: () => {
        mkdirSync(directory, { recursive: true });
        writeFileAtomic(path, JSON.stringify({
          instructions: fingerprint,
          ...(streak > 0 ? { compactionStreak: streak } : {}),
          ...(remaining > 0 ? { volatileCooldownTurns: remaining } : {}),
        }), { mode: 0o600 });
      },
    };
  }
  const trackReAnchor = reAnchorAfterTurns > 0 && hasVolatile;
  const nextTurnsSinceVolatile = deliverVolatile ? 0 : turnsSinceVolatile + 1;
  const preservedStreak = deliverVolatile ? (previous?.compactionStreak ?? 0) : 0;
  const receiptUnchanged = previous?.instructions === fingerprint
    && previous?.volatile === volatileFingerprint
    && (!trackReAnchor || previous?.turnsSinceVolatile === nextTurnsSinceVolatile)
    && (previous?.compactionStreak ?? 0) === preservedStreak
    && (previous?.volatileCooldownTurns ?? 0) === 0;
  const commitVolatile = receiptUnchanged
    ? null
    : () => {
        mkdirSync(directory, { recursive: true });
        writeFileAtomic(path, JSON.stringify({
          instructions: fingerprint,
          volatile: volatileFingerprint,
          ...(trackReAnchor ? { turnsSinceVolatile: nextTurnsSinceVolatile } : {}),
          ...(preservedStreak > 0 ? { compactionStreak: preservedStreak } : {}),
        }), { mode: 0o600 });
      };
  return { deliverVolatile, hadVolatile, commitVolatile };
}
