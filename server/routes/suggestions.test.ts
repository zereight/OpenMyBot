import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSuggestionsStore } from "../suggestions.ts";
import { createSuggestionsRoutes } from "./suggestions.ts";

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-suggestions-route-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function callRoute(
  handler: ReturnType<typeof createSuggestionsRoutes>,
  method: string,
  rawUrl: string,
  allowed = true,
) {
  let status = 0;
  let body: unknown;
  const url = new URL(rawUrl, "http://127.0.0.1");
  const result = await handler({
    req: {} as never,
    res: {} as never,
    url,
    path: url.pathname,
    method,
    auth: (allowed ? { kind: "loopback", trust: "user", scopes: ["admin"] } : { kind: "session", scopes: [] }) as never,
    json: (_res: unknown, code: number, payload: unknown) => { status = code; body = payload; },
  } as never);
  return { result, status, body };
}

describe("createSuggestionsRoutes", () => {
  it("lists, triggers look-around, accepts, and dismisses suggestions", async () => {
    const dir = makeDir();
    const suggestions = createSuggestionsStore({ dataDir: dir });
    const added = suggestions.addFromTurn("t1", { id: "chief", name: "Chief" }, {
      title: "Check release notes",
      summary: "Draft ready",
      prompt: "Review release notes",
    });
    if (!added.ok) throw new Error("expected add");

    const startAccepted = vi.fn(async () => ({ threadId: "new-thread-1", botId: "chief" }));
    const lookAround = {
      start: vi.fn(async (botId: string) =>
        botId === "chief"
          ? ({ ok: true as const, threadId: "look-1", startedAt: 100 })
          : ({ ok: false as const, reason: "not_found" as const, error: "Bot not found." })),
      status: () => ({ running: false }),
    };
    const handler = createSuggestionsRoutes({
      suggestions,
      lookAround,
      allowed: (auth) => auth.scopes.includes("admin"),
      startAccepted,
    });

    const denied = await callRoute(handler, "GET", "/api/suggestions", false);
    expect(denied.status).toBe(403);

    const listRes = await callRoute(handler, "GET", "/api/suggestions?status=open");
    expect(listRes.status).toBe(200);
    expect((listRes.body as { suggestions: unknown[] }).suggestions).toHaveLength(1);

    const triggerRes = await callRoute(handler, "POST", "/api/bots/chief/look-around");
    expect(triggerRes.status).toBe(202);

    const missingBot = await callRoute(handler, "POST", "/api/bots/missing/look-around");
    expect(missingBot.status).toBe(404);

    const acceptRes = await callRoute(handler, "POST", `/api/suggestions/${added.item.id}/accept`);
    expect(acceptRes.status).toBe(200);
    expect(startAccepted).toHaveBeenCalledTimes(1);
    expect((acceptRes.body as { threadId?: string }).threadId).toBe("new-thread-1");

    const second = suggestions.addFromTurn("t2", { id: "chief", name: "Chief" }, { title: "Another item" });
    if (!second.ok) throw new Error("expected add");
    const dismissRes = await callRoute(handler, "POST", `/api/suggestions/${second.item.id}/dismiss`);
    expect(dismissRes.status).toBe(200);
    expect(suggestions.get(second.item.id)?.status).toBe("dismissed");
  });
});
