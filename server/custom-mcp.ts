// config.json: { "mcpServers": { "notes": { "command": "npx", "args": ["-y", "@x/notes-mcp"], "env": { "NOTES_TOKEN": "…" } },
//                                "docs": { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } } } }
import type { AppConfig } from "./config.ts";
import type { McpServerSpec } from "./contracts.ts";
import { isRemoteMcpServer, mcpServerServes, parseStoredMcpServer } from "./mcp-registry.ts";
import { postizKeyHeaders } from "./postiz/connection.ts";

export type CustomMcpServer = McpServerSpec;

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

export function customMcpServers(cfg: AppConfig, only?: string[], botId?: string): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (only && !only.includes(name)) continue;
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) {
      skipMcpEntry(name, `${parsed.error} Expected { "command": "npx", "args": [...], "env": { ... } } or { "type": "http", "url": "https://…", "headers": { ... } }`);
      continue;
    }
    if (!parsed.server.enabled || parsed.server.runsOn || !mcpServerServes(parsed.server, botId)) continue; // another computer's or bot's own
    out[name] = isRemoteMcpServer(parsed.server)
      ? { type: parsed.server.type, url: parsed.server.url, headers: { ...parsed.server.headers, ...postizKeyHeaders(cfg.postiz, name, parsed.server) } }
      : { command: parsed.server.command, args: parsed.server.args, env: parsed.server.env };
  }
  return out;
}
