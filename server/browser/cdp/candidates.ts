import { callOnNode } from "./evaluate.ts";
import type { FrameTree } from "./frames.ts";
import type { NodeHandle, RefTable } from "./refs.ts";

/** One element an ambiguous selector matched, named so the agent can click it by ref without another snapshot. */
export interface MatchCandidate {
  ref: string;
  role: string;
  name: string;
  /** The nearest row, card, form or dialog heading/text around it, to tell identical controls apart. */
  context?: string;
}

/** Candidates attached to the error, and how many raw matches are looked at to find them. */
export const CANDIDATE_LIMIT = 5;
export const CANDIDATE_SCAN = 12;

/** A page-side check shared by the collectors: shown on the page and not disabled. */
export const USABLE_ELEMENT = `(el) => (!el.checkVisibility || el.checkVisibility()) && !el.disabled && el.getAttribute("aria-disabled") !== "true"`;

interface Described {
  usable: boolean;
  role: string;
  name: string;
  context: string;
}

const DESCRIBE = `function () {
  const norm = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const usable = ${USABLE_ELEMENT};
  const tag = this.tagName.toLowerCase();
  const type = String(this.getAttribute("type") || "").toLowerCase();
  const implicit = {
    a: this.hasAttribute("href") ? "link" : "", button: "button", summary: "button", select: "combobox", textarea: "textbox",
    input: ["button", "submit", "reset", "image"].includes(type) ? "button" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox",
  };
  const role = norm(this.getAttribute("role")) || implicit[tag] || tag;
  const labelled = norm(this.getAttribute("aria-labelledby")).split(" ").map((id) => norm(document.getElementById(id)?.textContent)).join(" ").trim();
  const buttonValue = tag === "input" && ["button", "submit", "reset"].includes(type) ? norm(this.value) : "";
  const name = norm(this.getAttribute("aria-label")) || labelled || norm(this.innerText) || buttonValue || norm(this.getAttribute("title")) || norm(this.getAttribute("alt"));
  const box = this.parentElement && this.parentElement.closest('li,tr,[role="row"],[role="listitem"],article,section,form,fieldset,dialog,[role="dialog"],[role="group"]');
  let context = "";
  if (box) {
    const heading = box.querySelector('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
    context = norm(heading && heading !== this ? heading.textContent : "") || norm(box.getAttribute("aria-label"));
    if (!context) {
      const text = norm(box.innerText);
      const at = name ? text.lastIndexOf(name) : -1;
      context = norm(at >= 0 ? text.slice(0, at) + text.slice(at + name.length) : text);
    }
  }
  return { usable: usable(this), role, name: name.slice(0, 80), context: context.slice(0, 60) };
}`;

/**
 * The visible, enabled elements an ambiguous selector matched, as ref + role + name + surrounding context, exact-name matches first.
 * `next(i)` is the i-th raw match in the main frame, or null when there are no more. Never throws: an error here must not
 * replace the "ambiguous" error it decorates.
 */
export async function collectCandidates(
  frames: FrameTree,
  refs: RefTable,
  next: (index: number) => Promise<number | null>,
  wanted?: string,
): Promise<{ candidates: MatchCandidate[]; more: boolean }> {
  const found: MatchCandidate[] = [];
  let more = false;
  try {
    for (let index = 0; index < CANDIDATE_SCAN; index += 1) {
      const backendNodeId = await next(index);
      if (backendNodeId === null) break;
      const handle: NodeHandle = { frameId: frames.mainFrameId, session: frames.mainSession, backendNodeId };
      const described = await callOnNode<Described>(frames, handle, DESCRIBE);
      if (!described.usable) continue;
      if (found.length >= CANDIDATE_LIMIT) {
        more = true;
        break;
      }
      found.push({ ref: refs.refFor(handle), role: described.role, name: described.name, ...(described.context ? { context: described.context } : {}) });
    }
  } catch {
    return { candidates: [], more: false };
  }
  const exact = (candidate: MatchCandidate) => wanted !== undefined && candidate.name.toLowerCase() === wanted.toLowerCase();
  return { candidates: [...found.filter(exact), ...found.filter((candidate) => !exact(candidate))], more };
}

/** The lines appended to an ambiguous-selector error. Empty when nothing usable matched. */
export function describeCandidates({ candidates, more }: { candidates: MatchCandidate[]; more: boolean }): string {
  if (candidates.length === 0) return "";
  const lines = candidates.map((c) => `- ${c.ref} ${c.role}${c.name ? ` ${JSON.stringify(c.name)}` : ""}${c.context ? ` (in ${JSON.stringify(c.context)})` : ""}`);
  return `\nVisible, enabled matches; click one by its ref:\n${lines.join("\n")}${more ? "\n- (more matches not shown)" : ""}`;
}
