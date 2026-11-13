// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), bots: [] as Bot[] }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: (_threadId: string, level?: string) => level !== "view" }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: fixture.dispatch }) };
});

const { ThreadBoard, MapViewToggle, BOARD_CARDS_SHOWN } = await import("./ThreadBoard");
const { useMapView } = await import("@/lib/map-view");

const now = Date.now();
const task = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: `Title ${threadId}`, createdAt: now - 1000, updatedAt: now - 60_000, ...extra });
const bot = (id: string, tasks: Task[], extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-main`, name: id, title: "", description: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: { instanceId: "fake", model: "test" }, tasks, ...extra,
});

let host: HTMLDivElement;
let root: Root;
const render = (node: Parameters<Root["render"]>[0]) => flushSync(() => root.render(node));
const column = (name: string) => host.querySelector(`[data-board-column="${name}"]`)!;

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ messages: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("ThreadBoard", () => {
  it("shows each thread under its column and opens the thread on click", () => {
    fixture.bots = [bot("ada", [task("ask", { activity: "waiting-on-you" }), task("run", { busy: true }), task("calm")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [{ key: "", name: "General" }] }));
    expect(column("attention").textContent).toContain("Title ask");
    expect(column("working").textContent).toContain("Title run");
    expect(column("idle").textContent).toContain("Title calm");
    expect(column("done").textContent).toContain("Nothing here");
    expect(column("archived").textContent).toContain("Nothing here");
    flushSync(() => column("attention").querySelector<HTMLButtonElement>("[data-board-card]")!.click());
    expect(fixture.dispatch).not.toHaveBeenCalled();
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-board-panel-open]")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "revealThread", threadId: "ask" });
  });

  it("narrows to one team and lists it only when there is more than one", () => {
    fixture.bots = [bot("ada", [task("a1")], { section: "Design" }), bot("bob", [task("b1")])];
    const teams = [{ key: "", name: "General" }, { key: "Design", name: "Design" }];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams }));
    const select = host.querySelector<HTMLSelectElement>("#board-team")!;
    expect(host.textContent).toContain("Title a1");
    expect(host.textContent).toContain("Title b1");
    select.value = "Design";
    flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(host.textContent).toContain("Title a1");
    expect(host.textContent).not.toContain("Title b1");
    flushSync(() => root.render(createElement(ThreadBoard, { bots: fixture.bots, teams: teams.slice(0, 1) })));
    expect(host.querySelector("#board-team")).toBeNull();
  });

  describe("with every team shown", () => {
    const teams = [{ key: "", name: "General" }, { key: "Design", name: "Design" }, { key: "Ops", name: "Ops" }];
    const lane = (key: string) => host.querySelector(`[data-board-team="${key}"]`)!;
    const lanesOf = () => [...host.querySelectorAll("[data-board-team]")].map((el) => el.getAttribute("data-board-team"));
    const pick = (value: string) => {
      const select = host.querySelector<HTMLSelectElement>("#board-team")!;
      select.value = value;
      flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    };

    it("splits the board into one lane per team, each with its own columns", () => {
      fixture.bots = [
        bot("ada", [task("a-run", { busy: true }), task("a-calm")], { section: "Design" }),
        bot("bob", [task("b-run", { busy: true })]),
        bot("cy", [task("c-old", { archivedAt: now - 1000 })], { section: "Ops" }),
      ];
      render(createElement(ThreadBoard, { bots: fixture.bots, teams }));
      expect(lanesOf()).toEqual(["", "Design", "Ops"]);
      expect(lane("Design").querySelectorAll("[data-board-column]")).toHaveLength(6);
      expect(lane("Design").querySelector('[data-board-column="working"]')!.textContent).toContain("Title a-run");
      expect(lane("Design").querySelector('[data-board-column="working"]')!.textContent).not.toContain("Title b-run");
      expect(lane("").querySelector('[data-board-column="working"]')!.textContent).toContain("Title b-run");
      expect(lane("Design").textContent).toContain("Title a-calm");
      expect(lane("").textContent).not.toContain("Title a-calm");
      expect(lane("Ops").querySelector('[data-board-column="archived"]')!.textContent).toContain("Title c-old");
      expect(lane("Design").querySelector("h2")!.textContent).toBe("Design2");
    });

    it("skips a team with no bots, and keeps a bot whose team is not listed", () => {
      fixture.bots = [bot("ada", [task("a1")], { section: "Design" }), bot("zed", [task("z1")], { section: "Gone" })];
      render(createElement(ThreadBoard, { bots: fixture.bots, teams }));
      expect(lanesOf()).toEqual(["Design", "Gone"]);
      expect(lane("Gone").textContent).toContain("Title z1");
    });

    it("goes back to one plain board once a single team is chosen", () => {
      fixture.bots = [bot("ada", [task("a1")], { section: "Design" }), bot("bob", [task("b1")])];
      render(createElement(ThreadBoard, { bots: fixture.bots, teams }));
      pick("Design");
      expect(lanesOf()).toEqual([]);
      expect(host.querySelectorAll("[data-board-column]")).toHaveLength(6);
      expect(host.textContent).toContain("Title a1");
      expect(host.textContent).not.toContain("Title b1");
      pick("");
      expect(lanesOf()).toEqual(["", "Design"]);
    });

    it("opens the panel for a card in a lane, and deleting it moves the panel to the neighbour in the same lane", () => {
      fixture.bots = [bot("ada", [task("a1", { updatedAt: now - 1000 }), task("a2", { updatedAt: now - 2000 })], { section: "Design" }), bot("bob", [task("b1")])];
      render(createElement(ThreadBoard, { bots: fixture.bots, teams }));
      flushSync(() => lane("Design").querySelector<HTMLButtonElement>('[data-board-card="a1"]')!.click());
      expect(host.querySelector("[data-board-panel-open]")).not.toBeNull();
      flushSync(() => host.querySelector<HTMLButtonElement>('[data-board-delete="a1"]')!.click());
      const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!;
      flushSync(() => confirm.click());
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "deleteTask", botId: "ada", threadId: "a1", onError: expect.any(Function) });
      expect(host.querySelector('[data-board-card="a2"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelector('[data-board-card="b1"]')!.getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("caps a long column and reveals the rest on request", () => {
    const many = Array.from({ length: BOARD_CARDS_SHOWN + 5 }, (_, index) => task(`t${index}`));
    fixture.bots = [bot("ada", many)];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect(column("idle").querySelectorAll("[data-board-card]")).toHaveLength(BOARD_CARDS_SHOWN);
    const more = [...column("idle").querySelectorAll("button")].find((button) => button.textContent === "Show 5 more")!;
    flushSync(() => more.click());
    expect(column("idle").querySelectorAll("[data-board-card]")).toHaveLength(BOARD_CARDS_SHOWN + 5);
  });
});

describe("ThreadBoard card actions", () => {
  const card = (threadId: string) => host.querySelector<HTMLElement>(`[data-board-card="${threadId}"]`)!;
  const act = (kind: "archive" | "delete", threadId: string) => host.querySelector<HTMLButtonElement>(`[data-board-${kind}="${threadId}"]`)!;

  it("archives an idle thread and restores an archived one without opening it", () => {
    fixture.bots = [bot("ada", [task("calm"), task("old", { archivedAt: now - 1000 })])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    flushSync(() => act("archive", "calm").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "ada", threadId: "calm", patch: { archivedAt: expect.any(Number) } });
    flushSync(() => act("archive", "old").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "ada", threadId: "old", patch: { archivedAt: null } });
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "revealThread" }));
  });

  it("asks before deleting and deletes only after confirming", () => {
    fixture.bots = [bot("ada", [task("calm")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    flushSync(() => act("delete", "calm").click());
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete thread?");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!;
    flushSync(() => confirm.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "deleteTask", botId: "ada", threadId: "calm", onError: expect.any(Function) });
  });

  it("lists an archived thread in the Archived column, where it can be restored or deleted", () => {
    fixture.bots = [bot("ada", [task("calm"), task("old", { archivedAt: now - 1000 })])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect(column("archived").textContent).toContain("Title old");
    expect(column("idle").textContent).not.toContain("Title old");
    fixture.bots = [bot("ada", [task("calm", { archivedAt: now }), task("old", { archivedAt: now - 1000 })])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect([...column("archived").querySelectorAll("[data-board-card]")].map((entry) => entry.getAttribute("data-board-card"))).toEqual(["calm", "old"]);
    expect(column("idle").textContent).not.toContain("Title calm");
    expect(column("archived").querySelector("[data-board-delete=old]")).not.toBeNull();
  });

  it("takes a deleted thread off the board at once and brings it back when the delete fails", () => {
    fixture.bots = [bot("ada", [task("calm"), task("other")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    flushSync(() => act("delete", "calm").click());
    flushSync(() => [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!.click());
    expect(card("calm")).toBeNull();
    expect(card("other")).not.toBeNull();
    const deleted = fixture.dispatch.mock.calls.map(([action]) => action).find((action) => action.type === "deleteTask");
    flushSync(() => deleted.onError());
    expect(card("calm")).not.toBeNull();
  });

  it("does not delete a thread that started working while the dialog was open", () => {
    fixture.bots = [bot("ada", [task("calm")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    flushSync(() => act("delete", "calm").click());
    fixture.bots = [bot("ada", [task("calm", { busy: true })])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete thread");
    if (confirm) flushSync(() => confirm.click());
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteTask" }));
  });

  it("locks a working thread but still lets a stalled one be cleared, and hides the actions from a view-only bot", () => {
    fixture.bots = [bot("ada", [task("run", { busy: true }), task("dead", { activity: "dead" })]), bot("view", [task("v1")], { yourAccess: "view" })];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect(act("archive", "run").disabled).toBe(true);
    expect(act("delete", "run").disabled).toBe(true);
    expect(act("delete", "dead").disabled).toBe(false);
    expect(card("v1")).not.toBeNull();
    expect(act("archive", "v1")).toBeNull();
  });
});

describe("ThreadBoard panel", () => {
  const panel = () => host.querySelector<HTMLElement>("[data-board-panel]");
  const input = () => host.querySelector<HTMLTextAreaElement>("[data-board-panel] textarea")!;
  const select = (threadId: string) => flushSync(() => host.querySelector<HTMLButtonElement>(`[data-board-card="${threadId}"]`)!.click());
  const type = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input(), value);
    flushSync(() => input().dispatchEvent(new Event("input", { bubbles: true })));
  };
  const press = (init: KeyboardEventInit) => flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
  const sent = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "send");

  it("opens beside the board, shows the thread's newest messages and closes", async () => {
    fixture.api.mockResolvedValue({ messages: [
      { id: "m1", role: "user", kind: "text", text: "hello there", at: now },
      { id: "m2", role: "bot", kind: "text", text: "hi, how can I help", at: now },
      { id: "m3", role: "bot", kind: "activity", text: "ran a tool", at: now },
    ] });
    fixture.bots = [bot("ada", [task("calm")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect(panel()).toBeNull();
    select("calm");
    expect(panel()).not.toBeNull();
    expect(fixture.api).toHaveBeenCalledWith("/api/threads/calm/messages?limit=20", expect.anything());
    await vi.waitFor(() => expect(panel()!.textContent).toContain("hi, how can I help"));
    expect(panel()!.textContent).toContain("hello there");
    expect(panel()!.textContent).not.toContain("ran a tool");
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-board-panel-close]")!.click());
    expect(panel()).toBeNull();
  });

  it("sends to the selected thread, shows the line as sending, and keeps IME confirmation from sending", () => {
    fixture.bots = [bot("ada", [task("calm"), task("other")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    select("calm");
    type("hello");
    press({ key: "Enter", isComposing: true });
    press({ key: "Enter", keyCode: 229 });
    expect(sent()).toHaveLength(0);
    press({ key: "Enter" });
    expect(sent()).toEqual([expect.objectContaining({ botId: "ada", threadId: "calm", text: "hello", sendId: expect.any(String) })]);
    expect(input().value).toBe("");
    expect(panel()!.querySelector("[data-board-message=pending]")!.textContent).toContain("hello");
  });

  it("puts the text back when the send fails", () => {
    fixture.bots = [bot("ada", [task("calm")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    select("calm");
    type("again");
    press({ key: "Enter" });
    flushSync(() => sent()[0].onError());
    expect(input().value).toBe("again");
    expect(panel()!.querySelector("[data-board-message=pending]")).toBeNull();
  });

  it("does not take a message for a thread that is waiting on the person, an archived one or a view-only bot", () => {
    fixture.bots = [bot("ada", [task("ask", { activity: "waiting-on-you" }), task("old", { archivedAt: now - 1000 })]), bot("view", [task("v1")], { yourAccess: "view" })];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    for (const threadId of ["ask", "old", "v1"]) {
      select(threadId);
      expect(input().disabled).toBe(true);
      press({ key: "Enter" });
    }
    expect(sent()).toHaveLength(0);
    select("ask");
    expect(panel()!.querySelector("[data-board-panel-note]")!.textContent).toContain("waiting for your answer");
  });

  it("keeps the panel open on the next card when its own thread is deleted", () => {
    fixture.bots = [bot("ada", [task("first", { updatedAt: now - 1000 }), task("second", { updatedAt: now - 2000 }), task("third", { updatedAt: now - 3000 })])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    const remove = (threadId: string) => {
      flushSync(() => host.querySelector<HTMLButtonElement>(`[data-board-delete="${threadId}"]`)!.click());
      flushSync(() => [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!.click());
    };
    select("second");
    remove("second");
    expect(panel()!.getAttribute("data-board-panel")).toBe("third");
    remove("third");
    expect(panel()!.getAttribute("data-board-panel")).toBe("first");
    remove("first");
    expect(panel()).toBeNull();
  });

  it("leaves the panel on a thread when a different one is deleted", () => {
    fixture.bots = [bot("ada", [task("calm"), task("other")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    select("calm");
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-board-delete=other]")!.click());
    flushSync(() => [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!.click());
    expect(panel()!.getAttribute("data-board-panel")).toBe("calm");
  });

  it("follows an archived thread into the Archived column without closing", () => {
    fixture.bots = [bot("ada", [task("calm")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    select("calm");
    fixture.bots = [bot("ada", [task("calm", { archivedAt: now })])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect(panel()!.getAttribute("data-board-panel")).toBe("calm");
    expect(column("archived").querySelector("[data-board-card=calm]")).not.toBeNull();
    expect(panel()!.querySelector("[data-board-panel-note]")).not.toBeNull();
  });

  it("closes when the selected thread leaves the board", () => {
    fixture.bots = [bot("ada", [task("calm"), task("other")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    select("calm");
    expect(panel()).not.toBeNull();
    fixture.bots = [bot("ada", [task("other")])];
    render(createElement(ThreadBoard, { bots: fixture.bots, teams: [] }));
    expect(panel()).toBeNull();
  });
});

describe("MapViewToggle", () => {
  it("switches the shared view between map and board", () => {
    let seen = "";
    const Probe = () => { seen = useMapView(); return null; };
    render(createElement("div", null, createElement(MapViewToggle), createElement(Probe)));
    const [map, board] = [...host.querySelectorAll("button")];
    expect(seen).toBe("map");
    flushSync(() => board!.click());
    expect(seen).toBe("board");
    flushSync(() => map!.click());
    expect(seen).toBe("map");
  });
});
