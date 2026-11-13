import { collectCandidates, describeCandidates, USABLE_ELEMENT } from "./candidates.ts";
import { DriverError, messageOf } from "./errors.ts";
import { callInWorld } from "./evaluate.ts";
import type { FrameTree } from "./frames.ts";
import { parseRef, type NodeHandle, type RefTable } from "./refs.ts";

/**
 * A selector names elements in the main frame, open shadow roots included:
 * CSS (optionally `css=`), `role=button[name="Save"]` (accessible role and exact
 * name; `name*=` matches part of it) or `text=Save` (`text="Save"` is exact).
 * Refs from a snapshot reach iframes and closed shadow roots.
 */
export type Selector = { engine: "css"; css: string } | { engine: "role"; role: string; name?: string; partial: boolean } | { engine: "text"; text: string; exact: boolean };

const ROLE = /^role=([a-zA-Z]+)\s*(?:\[\s*name\s*(\*?)=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\])?$/;

export function parseSelector(input: string): Selector {
  const selector = input.trim();
  if (!selector) throw new DriverError("invalid-selector", "The selector is empty.");
  if (selector.startsWith("role=")) {
    const match = ROLE.exec(selector);
    if (!match) throw new DriverError("invalid-selector", `Cannot read the role selector ${selector}. Write it as role=button[name="Save"].`);
    const raw = match[3] ?? match[4];
    return { engine: "role", role: match[1]!.toLowerCase(), ...(raw === undefined ? {} : { name: raw.replace(/\\(.)/g, "$1") }), partial: match[2] === "*" };
  }
  if (selector.startsWith("text=")) {
    const text = selector.slice(5).trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(text);
    if (quoted) return { engine: "text", text: quoted[1]!.replace(/\\(.)/g, "$1"), exact: true };
    if (!text) throw new DriverError("invalid-selector", "The text selector is empty.");
    return { engine: "text", text, exact: false };
  }
  return { engine: "css", css: selector.startsWith("css=") ? selector.slice(4) : selector };
}

const QUERY_CSS = `function (css) {
  const found = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll(css)) found.push(element);
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(this);
  return found.length === 1 ? found[0] : found.length;
}`;

const QUERY_TEXT = `function (text, exact) {
  const normal = (value) => value.replace(/\\s+/g, " ").trim();
  const wanted = exact ? normal(text) : normal(text).toLowerCase();
  const matches = (element) => {
    if (element.checkVisibility && !element.checkVisibility()) return false;
    const own = normal(element.innerText ?? element.textContent ?? "");
    return exact ? own === wanted : own.toLowerCase().includes(wanted);
  };
  const found = [];
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let element = walker.nextNode(); element; element = walker.nextNode()) {
      if (element.shadowRoot) visit(element.shadowRoot);
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(element.tagName)) continue;
      if (matches(element) && ![...element.children].some(matches)) found.push(element);
    }
  };
  visit(this);
  return found.length === 1 ? found[0] : found.length;
}`;

/** The index-th visible, enabled CSS match (shadow roots included), or null: only the error's candidate list uses it. */
const NTH_CSS = `function (css, index) {
  const usable = ${USABLE_ELEMENT};
  const found = new Set();
  const visit = (root) => {
    for (const element of root.querySelectorAll(css)) found.add(element);
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(this);
  return [...found].filter(usable)[index] ?? null;
}`;

/** Like NTH_CSS for text matches, each lifted from its text node's element to the control around it, once. */
const NTH_TEXT = `function (text, exact, index) {
  const usable = ${USABLE_ELEMENT};
  const normal = (value) => value.replace(/\\s+/g, " ").trim();
  const wanted = exact ? normal(text) : normal(text).toLowerCase();
  const matches = (element) => {
    if (element.checkVisibility && !element.checkVisibility()) return false;
    const own = normal(element.innerText ?? element.textContent ?? "");
    return exact ? own === wanted : own.toLowerCase().includes(wanted);
  };
  const control = 'a,button,summary,label,input,select,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="option"]';
  const found = new Set();
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let element = walker.nextNode(); element; element = walker.nextNode()) {
      if (element.shadowRoot) visit(element.shadowRoot);
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(element.tagName)) continue;
      if (matches(element) && ![...element.children].some(matches)) found.add(element.closest(control) ?? element);
    }
  };
  visit(this);
  return [...found].filter(usable)[index] ?? null;
}`;

interface AXQueryNode {
  backendDOMNodeId?: number;
  ignored?: boolean;
  name?: { value?: unknown };
}

async function queryRole(frames: FrameTree, selector: Extract<Selector, { engine: "role" }>): Promise<number[]> {
  const session = frames.mainSession;
  const { root } = await session.send<{ root: { backendNodeId: number } }>("DOM.getDocument", { depth: 0 });
  const exactName = selector.name !== undefined && !selector.partial ? { accessibleName: selector.name } : {};
  const { nodes } = await session.send<{ nodes: AXQueryNode[] }>("Accessibility.queryAXTree", { backendNodeId: root.backendNodeId, role: selector.role, ...exactName });
  const wanted = selector.partial && selector.name !== undefined ? selector.name.toLowerCase() : null;
  return nodes
    .filter((node) => !node.ignored && typeof node.backendDOMNodeId === "number")
    .filter((node) => wanted === null || String(node.name?.value ?? "").toLowerCase().includes(wanted))
    .map((node) => node.backendDOMNodeId!);
}

/** Every match (CSS and text return a count instead of nodes when there is more than one). */
async function query(frames: FrameTree, selector: Selector): Promise<{ count: number; backendNodeId?: number }> {
  if (selector.engine === "role") {
    const ids = [...new Set(await queryRole(frames, selector))];
    return { count: ids.length, ...(ids.length === 1 ? { backendNodeId: ids[0] } : {}) };
  }
  const fn = selector.engine === "css" ? QUERY_CSS : QUERY_TEXT;
  const args = selector.engine === "css" ? [selector.css] : [selector.text, selector.exact];
  let answer: Awaited<ReturnType<typeof callInWorld>>;
  try {
    answer = await callInWorld(frames, frames.mainFrameId, fn, args);
  } catch (error) {
    if (selector.engine === "css" && /SyntaxError|not a valid selector/i.test(messageOf(error))) {
      throw new DriverError("invalid-selector", `${selector.css} is not a valid CSS selector.`);
    }
    throw error;
  }
  const { session, result } = answer;
  if (result.type === "number") return { count: Number(result.value) };
  if (!result.objectId) return { count: 0 };
  try {
    const { node } = await session.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: result.objectId });
    return { count: 1, backendNodeId: node.backendNodeId };
  } finally {
    void session.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
  }
}

export async function countSelector(frames: FrameTree, input: string): Promise<number> {
  return (await query(frames, parseSelector(input))).count;
}

/** Exactly one element, or an error: an ambiguous selector never acts on the first match. */
export async function resolveSelector(frames: FrameTree, input: string): Promise<NodeHandle> {
  const { count, backendNodeId } = await query(frames, parseSelector(input));
  if (count === 0) throw new DriverError("not-found", `No element matches ${input}.`);
  if (count > 1 || backendNodeId === undefined) {
    throw new DriverError("ambiguous", `strict mode violation: ${input} matches ${count} elements. Use a ref from a snapshot, or a selector that names one element.`, { count });
  }
  return { frameId: frames.mainFrameId, session: frames.mainSession, backendNodeId };
}

/** The i-th match of an ambiguous selector as a node id, for the candidates the error lists. */
async function nthMatch(frames: FrameTree, selector: Selector, roleIds: number[], index: number): Promise<number | null> {
  if (selector.engine === "role") return roleIds[index] ?? null;
  const fn = selector.engine === "css" ? NTH_CSS : NTH_TEXT;
  const args = selector.engine === "css" ? [selector.css, index] : [selector.text, selector.exact, index];
  const { session, result } = await callInWorld(frames, frames.mainFrameId, fn, args);
  if (!result.objectId) return null;
  try {
    const { node } = await session.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: result.objectId });
    return node.backendNodeId;
  } finally {
    void session.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
  }
}

/** The ambiguous error, with the visible, enabled matches (ref, role, name, context) so one can be clicked without a snapshot. It still says "strict mode violation" and still acts on nothing. */
async function withCandidates(error: unknown, frames: FrameTree, refs: RefTable, input: string): Promise<unknown> {
  if (!(error instanceof DriverError) || error.code !== "ambiguous") return error;
  try {
    const selector = parseSelector(input);
    const roleIds = selector.engine === "role" ? [...new Set(await queryRole(frames, selector))] : [];
    const wanted = selector.engine === "role" ? selector.name : selector.engine === "text" ? selector.text : undefined;
    const found = await collectCandidates(frames, refs, (index) => nthMatch(frames, selector, roleIds, index), wanted);
    const extra = describeCandidates(found);
    return extra ? new DriverError("ambiguous", error.message + extra, { ...error.detail, candidates: found.candidates }) : error;
  } catch {
    return error;
  }
}

/** A ref, or a selector that reads as one ("aria-ref=e5"), resolves through the tab's refs. */
export async function resolveElement(frames: FrameTree, refs: RefTable, target: { ref?: string; selector?: string }): Promise<NodeHandle & { ref?: string }> {
  if (target.ref !== undefined) return refs.resolve(target.ref);
  if (target.selector === undefined) throw new DriverError("invalid-selector", "Name the element with a ref or a selector.");
  if (parseRef(target.selector)) return refs.resolve(target.selector);
  try {
    return await resolveSelector(frames, target.selector);
  } catch (error) {
    throw await withCandidates(error, frames, refs, target.selector);
  }
}
