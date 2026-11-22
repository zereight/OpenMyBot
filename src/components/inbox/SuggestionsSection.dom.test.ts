// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ path: string; method: string }>);
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.endsWith("/look-around")) return { ok: true, lookAround: { running: true, botId: "chief" } };
    if (path.endsWith("/accept")) return { ok: true, botId: "chief", threadId: "t-new" };
    return { ok: true };
  }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { setSuggestionsState } from "@/state/suggestions";
import { SuggestionsSection } from "./SuggestionsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const dispatch = vi.fn();
const bot = { id: "chief", name: "Chief", defaultBot: { person: "owner" }, tasks: [] } as unknown as Bot;
const mount = (child: ReactElement, bots: Bot[] = [bot]) => act(async () => {
  root.render(createElement(StoreContext.Provider, {
    value: {
      state: { ...initialState, bots, selectedId: bots[0]?.id ?? "" } as AppState,
      dispatch,
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    } as never,
  }, child));
});

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  calls.length = 0;
  dispatch.mockClear();
  setSuggestionsState({});
});

afterEach(() => {
  act(() => root.unmount());
  setSuggestionsState({});
  document.body.innerHTML = "";
});

describe("SuggestionsSection", () => {
  it("triggers look-around, accepts a suggestion, and dismisses another", async () => {
    setSuggestionsState({
      suggestions: [
        { id: "s1", botId: "chief", botName: "Chief", title: "Review PR #57", summary: "Ready for review", prompt: "Review PR #57", link: "https://example.com/pr/57", status: "open", createdAt: 2, updatedAt: 2 },
        { id: "s2", botId: "chief", botName: "Chief", title: "Ignore me", summary: "Low priority", prompt: "Ignore", status: "open", createdAt: 1, updatedAt: 1 },
      ],
    });
    await mount(createElement(SuggestionsSection));

    expect(document.querySelectorAll("[data-suggestion-id]")).toHaveLength(2);

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-look-around-button]")!.click();
    });
    expect(calls).toContainEqual({ path: "/api/bots/chief/look-around", method: "POST" });

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-suggestion-accept='s1']")!.click();
    });
    expect(calls).toContainEqual({ path: "/api/suggestions/s1/accept", method: "POST" });
    expect(document.querySelectorAll("[data-suggestion-id]")).toHaveLength(1);

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-suggestion-dismiss='s2']")!.click();
    });
    expect(calls).toContainEqual({ path: "/api/suggestions/s2/dismiss", method: "POST" });
    expect(document.querySelectorAll("[data-suggestion-id]")).toHaveLength(0);
  });
});
