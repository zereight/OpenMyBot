import {
  evaluateToolGuardrails,
  formatGuardrailBlock,
  parseRawToolIdentity,
} from "../../shared/tool-guardrails.ts";
import { readGuardrailPolicyFile } from "../tool-guardrail-policy-file.ts";

const MAX_INPUT_BYTES = 1024 * 1024;

function readRulesArg(argv: readonly string[]): string | null {
  const index = argv.indexOf("--rules");
  if (index < 0) return null;
  const value = argv[index + 1];
  return typeof value === "string" && value.trim() ? value : null;
}

function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) {
        resolve(null);
        return;
      }
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(null));
  });
}

function writeDeny(reason: string): Promise<void> {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  return new Promise((resolve) => process.stdout.write(output, () => resolve()));
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (raw === null) {
    await writeDeny(formatGuardrailBlock("policy-input-error", "Tool hook payload could not be read."));
    return;
  }
  let payload: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };
  try {
    payload = JSON.parse(raw) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };
  } catch {
    await writeDeny(formatGuardrailBlock("policy-input-error", "Tool hook payload is not valid JSON."));
    return;
  }
  if (payload.hook_event_name !== "PreToolUse" || typeof payload.tool_name !== "string") return;

  const rulesPath = readRulesArg(process.argv);
  if (!rulesPath) {
    await writeDeny(formatGuardrailBlock("policy-load-error", "Missing guardrail policy path."));
    return;
  }
  const loaded = readGuardrailPolicyFile(rulesPath);
  if (!loaded.ok) {
    await writeDeny(formatGuardrailBlock("policy-load-error", loaded.error));
    return;
  }
  const verdict = evaluateToolGuardrails(
    loaded.policy.rules,
    { tool: parseRawToolIdentity(payload.tool_name), input: payload.tool_input },
    { protectedPaths: loaded.policy.protectedPaths },
  );
  if (verdict.blocked) {
    await writeDeny(verdict.reason);
  }
}

main().then(() => process.exit(0), () => process.exit(0));
