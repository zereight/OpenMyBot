import type { SuggestionItem, SuggestionStatus, SuggestionsResponse } from "../../shared/suggestions.ts";
import type { LookAround } from "../look-around.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SuggestionsStore } from "../suggestions.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SuggestionsRouteDeps {
  suggestions: SuggestionsStore;
  lookAround: Pick<LookAround, "start" | "status">;
  /** Whether this caller may view or act on suggestions. */
  allowed(auth: RequestAuth): boolean;
  /** Starts a new thread for an accepted suggestion and returns its threadId, or null if unavailable. */
  startAccepted(auth: RequestAuth, suggestion: SuggestionItem): Promise<{ threadId: string; botId: string } | null>;
}

const VALID_STATUS = new Set<SuggestionStatus>(["open", "accepted", "dismissed"]);

export function createSuggestionsRoutes(deps: SuggestionsRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json }) => {
    if (path === "/api/suggestions") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.allowed(auth)) return json(res, 403, { error: "forbidden" });
      const rawStatus = url.searchParams.get("status");
      const status = rawStatus && VALID_STATUS.has(rawStatus as SuggestionStatus) ? (rawStatus as SuggestionStatus) : undefined;
      const botId = url.searchParams.get("botId")?.trim() || undefined;
      const payload: SuggestionsResponse = {
        suggestions: deps.suggestions.list({ ...(botId ? { botId } : {}), ...(status ? { status } : {}) }),
        lookAround: deps.lookAround.status(),
      };
      return json(res, 200, payload);
    }

    const lookMatch = /^\/api\/bots\/([\w-]+)\/look-around$/.exec(path);
    if (lookMatch) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!deps.allowed(auth)) return json(res, 403, { error: "forbidden" });
      const result = await deps.lookAround.start(lookMatch[1]!);
      if (!result.ok) {
        const code = result.reason === "not_found" ? 404 : result.reason === "already_running" ? 409 : 500;
        return json(res, code, { error: result.error ?? "Look-around could not start.", lookAround: deps.lookAround.status() });
      }
      return json(res, 202, { ok: true, threadId: result.threadId, startedAt: result.startedAt, lookAround: deps.lookAround.status() });
    }

    const actionMatch = /^\/api\/suggestions\/([\w-]+)\/(accept|dismiss)$/.exec(path);
    if (actionMatch) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!deps.allowed(auth)) return json(res, 403, { error: "forbidden" });
      const id = actionMatch[1]!;
      const action = actionMatch[2]!;
      const existing = deps.suggestions.get(id);
      if (!existing) return json(res, 404, { error: "Suggestion not found." });
      if (action === "dismiss") {
        const updated = deps.suggestions.dismiss(id)!;
        return json(res, 200, { ok: true, suggestion: updated });
      }
      if (existing.status === "accepted") {
        return json(res, 200, { ok: true, suggestion: existing, ...(existing.acceptedThreadId ? { threadId: existing.acceptedThreadId, botId: existing.botId } : {}) });
      }
      const started = await deps.startAccepted(auth, existing);
      const updated = deps.suggestions.accept(id, started?.threadId)!;
      return json(res, 200, { ok: true, suggestion: updated, ...(started ? { threadId: started.threadId, botId: started.botId } : {}) });
    }

    return PASS;
  };
}
