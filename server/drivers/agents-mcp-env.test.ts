import { describe, expect, it } from "vitest";

import { agentsServerEnv, type AgentsConversation } from "../agents-turn.ts";
import { AGENTS_NODE_FLAG } from "../proxy-paths.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { AGENTS_MCP_ENV } from "./agents-mcp-env.ts";

describe("the agents server's settings", () => {
  it("carry every switch the catalog reads, so a turn reaching the server over HTTP is listed the same tools", () => {
    const read = new Set<string>();
    catalogProfileFromEnv(new Proxy({}, { get: (_target, key) => { if (typeof key === "string") read.add(key); return undefined; } }));
    expect(read.size).toBeGreaterThan(10);
    for (const key of read) expect(AGENTS_MCP_ENV, key).toContain(key);
  });

  // Over HTTP only AGENTS_MCP_ENV travels (as a header); a key the stdio launch sets that is neither listed nor carried by
  // its own header would reach the server by stdio but silently vanish on the Claude driver's default URL route.
  it("list every setting the turn's stdio launch hands the server, bar the ones the URL route carries another way", () => {
    const conversation: AgentsConversation = {
      threadId: "t1", bot: { id: "b1" }, room: false, teamComputer: false,
      host: { skillAuthoring: true, sharedComputers: true, cloudHome: true, team: true, voiceNotes: true, x: true, research: true, imageGeneration: true, meetings: true, appHosting: true },
    };
    const launched = Object.keys(agentsServerEnv(conversation, { generation: "g", depth: 0, skillAuthoring: true }, () => "token", "http://127.0.0.1:1"));
    expect(launched.length).toBeGreaterThan(10);
    // The bearer and the harness address are the URL and the Authorization header; the Electron flag only starts the proxy process.
    const carriedAnotherWay = new Set(["OMB_HARNESS_URL", "OMB_COMMS_TOKEN", ...Object.keys(AGENTS_NODE_FLAG)]);
    const dropped = launched.filter((key) => !carriedAnotherWay.has(key) && !(AGENTS_MCP_ENV as readonly string[]).includes(key));
    expect(dropped).toEqual([]);
  });
});
