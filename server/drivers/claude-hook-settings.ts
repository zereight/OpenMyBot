function hookCommand(helperPath: string, platform: NodeJS.Platform): Record<string, unknown> {
  // Claude Code runs `command` as a shell line: sh on macOS and Linux; on Windows Git Bash, or PowerShell
  // when Git Bash is missing, and the two quote differently. Given `args` (2.1.139), it starts `command` itself.
  // JSON quoting is not shell quoting: $(), backticks and $names expand inside double quotes.
  return platform === "win32"
    ? { type: "command", command: process.execPath, args: [helperPath], timeout: 5 }
    : { type: "command", command: [process.execPath, helperPath].map(path => `'${path.replace(/'/g, "'\\''")}'`).join(" "), timeout: 5 };
}

/** Hooks for the private --settings file. Claude Code runs each command with the event JSON on
 * stdin and applies any hookSpecificOutput it prints. */
export function claudeHookSettings(helperPath: string, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const entry = [{ matcher: "", hooks: [hookCommand(helperPath, platform)] }];
  return { PostToolUse: entry, PostToolUseFailure: entry, PreCompact: entry, SessionStart: entry, Stop: entry };
}

/** A PreToolUse hook runs under every permission mode, Full access included, which the approval broker does not. */
export function browserGuardHookSettings(helperPath: string, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  return { PreToolUse: [{ matcher: "Bash|PowerShell|Monitor", hooks: [hookCommand(helperPath, platform)] }] };
}
