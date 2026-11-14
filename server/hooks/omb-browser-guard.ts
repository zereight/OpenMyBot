// Claude Code runs this as a PreToolUse hook with the call's JSON on stdin. It ALWAYS exits 0 and fails open: an
// unreadable payload or any error lets the call through. stdout is the hook channel: never console.log anything else here.
import { browserLaunchVerdict } from "./browser-launch-guard.ts";

const MAX_INPUT_BYTES = 1024 * 1024;

function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_INPUT_BYTES) resolve(null);
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(null));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (raw === null) return;
  let reason: string | null = null;
  try {
    const payload = JSON.parse(raw) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };
    if (payload.hook_event_name !== "PreToolUse" || typeof payload.tool_name !== "string") return;
    reason = browserLaunchVerdict(payload.tool_name, payload.tool_input);
  } catch {
    return;
  }
  if (reason === null) return;
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
}

main().then(() => process.exit(0), () => process.exit(0));
