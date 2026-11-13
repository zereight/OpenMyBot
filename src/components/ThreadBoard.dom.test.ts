// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), bots: [] as Bot[] }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: fixture.dispatch }) };
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
    flushSync(() => column("attention").querySelector<HTMLButtonElement>("[data-board-card]")!.click());
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
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "deleteTask", botId: "ada", threadId: "calm" });
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
