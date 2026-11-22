import { randomUUID } from "node:crypto";
import {
  APPROVAL_OUTPUTS,
  NODE_KINDS,
  OPTION_ID_RE,
  THRESHOLD_DEFAULT,
  WORKFLOW_PERMISSIONS,
  type WorkflowConnection,
  type WorkflowConnectionSource,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowOption,
  type WorkflowPermission,
} from "./types.ts";

/** A workflow step as a bot reads and writes it in chat: no canvas position, no number, no blank fields. */
export interface WorkflowNodeSpec {
  id: string;
  kind: WorkflowNodeKind;
  name: string;
  prompt?: string;
  question?: string;
  options?: WorkflowOption[];
  threshold?: number;
  instance_id?: string;
  model?: string;
  effort?: string;
  permission?: WorkflowPermission;
  continue_on_failure?: boolean;
}

/** `when` names the output port: a decision's option id, or an approval's approve or reject. */
export interface WorkflowConnectionSpec {
  from: string;
  to: string;
  when?: string;
}

export interface WorkflowGraphSpec {
  nodes: WorkflowNodeSpec[];
  connections: WorkflowConnectionSpec[];
}

const COLUMN_X = 80;
const COLUMN_STEP = 280;
const ROW_Y = 80;
const ROW_STEP = 140;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const optionalText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function sourceKey(source: WorkflowConnectionSource): string {
  if (source.kind === "option") return `option:${source.optionId}`;
  if (source.kind === "verdict") return `verdict:${source.verdict}`;
  return "text";
}

function whenOf(source: WorkflowConnectionSource): string | undefined {
  if (source.kind === "option") return source.optionId;
  if (source.kind === "verdict") return source.verdict;
  return undefined;
}

export function specFromGraph(graph: WorkflowGraph): WorkflowGraphSpec {
  return {
    nodes: graph.nodes.map((node): WorkflowNodeSpec => {
      const spec: WorkflowNodeSpec = { id: node.id, kind: node.kind, name: node.name };
      if (node.kind === "text") {
        spec.prompt = node.prompt;
        if (node.instanceId) spec.instance_id = node.instanceId;
        if (node.model) spec.model = node.model;
        if (node.effort) spec.effort = node.effort;
        if (node.permission) spec.permission = node.permission;
      } else {
        spec.question = node.question;
      }
      if (node.kind === "decision") {
        spec.options = node.options.map((option) => ({ ...option }));
        spec.threshold = node.threshold;
      }
      if (node.continueOnFailure) spec.continue_on_failure = true;
      return spec;
    }),
    connections: graph.connections.map((connection) => {
      const when = whenOf(connection.source);
      return { from: connection.from, to: connection.to, ...(when ? { when } : {}) };
    }),
  };
}

function parseNode(raw: unknown, at: string): Omit<WorkflowNode, "number" | "x" | "y"> | string {
  if (!isRecord(raw)) return `${at} must be an object.`;
  if (typeof raw.id !== "string" || !OPTION_ID_RE.test(raw.id)) return `${at}.id must be 1-64 letters, digits, _ . or -.`;
  if (!(NODE_KINDS as readonly unknown[]).includes(raw.kind)) return `${at}.kind must be text, decision or approval.`;
  if (typeof raw.name !== "string") return `${at}.name is required.`;
  if (raw.permission !== undefined && !(WORKFLOW_PERMISSIONS as readonly unknown[]).includes(raw.permission)) return `${at}.permission must be full, edits or ask.`;
  if (raw.threshold !== undefined && typeof raw.threshold !== "number") return `${at}.threshold must be a number from 0 to 1.`;
  if (raw.options !== undefined && !Array.isArray(raw.options)) return `${at}.options must be a list of {id, label}.`;
  const options: WorkflowOption[] = [];
  for (const [index, option] of ((raw.options as unknown[] | undefined) ?? []).entries()) {
    if (!isRecord(option) || typeof option.id !== "string") return `${at}.options[${index}] needs an id.`;
    options.push({ id: option.id, label: typeof option.label === "string" && option.label.trim() ? option.label : option.id });
  }
  return {
    id: raw.id,
    kind: raw.kind as WorkflowNodeKind,
    name: raw.name,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    instanceId: optionalText(raw.instance_id),
    model: optionalText(raw.model),
    effort: optionalText(raw.effort),
    permission: (raw.permission as WorkflowPermission | undefined) ?? null,
    continueOnFailure: raw.continue_on_failure === true,
    question: typeof raw.question === "string" ? raw.question : "",
    threshold: (raw.threshold as number | undefined) ?? THRESHOLD_DEFAULT,
    options,
  };
}

function parseConnection(raw: unknown, at: string, kindOf: ReadonlyMap<string, WorkflowNodeKind>): Omit<WorkflowConnection, "id"> | string {
  if (!isRecord(raw) || typeof raw.from !== "string" || typeof raw.to !== "string") return `${at} needs from and to step ids.`;
  const when = optionalText(raw.when);
  const fromKind = kindOf.get(raw.from);
  if (!fromKind) return `${at}: unknown from step "${raw.from}".`;
  if (fromKind === "decision") {
    if (!when) return `${at}: a connection from decision "${raw.from}" needs when, one of its option ids.`;
    return { from: raw.from, to: raw.to, source: { kind: "option", optionId: when } };
  }
  if (fromKind === "approval") {
    if (!when || !(APPROVAL_OUTPUTS as readonly string[]).includes(when)) return `${at}: a connection from approval "${raw.from}" needs when, approve or reject.`;
    return { from: raw.from, to: raw.to, source: { kind: "verdict", verdict: when as (typeof APPROVAL_OUTPUTS)[number] } };
  }
  if (when) return `${at}: a text step has one output, so leave when out.`;
  return { from: raw.from, to: raw.to, source: { kind: "text" } };
}

function depths(nodeIds: readonly string[], connections: ReadonlyArray<Omit<WorkflowConnection, "id">>): Map<string, number> {
  const depth = new Map(nodeIds.map((id) => [id, 0]));
  for (let pass = 0; pass < nodeIds.length; pass++) {
    let moved = false;
    for (const { from, to } of connections) {
      const next = (depth.get(from) ?? 0) + 1;
      if (depth.has(to) && next > depth.get(to)! && next < nodeIds.length) {
        depth.set(to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

/** The stored graph for `raw`, keeping the number, place and connection id of every step and link `previous` already had,
 * and laying new steps out in columns by how far down the flow they are. Graph rules (cycles, ports, option counts) are
 * checkWorkflowGraph's; this only reads the shape. */
export function graphFromSpec(raw: unknown, previous: WorkflowGraph | null): { graph: WorkflowGraph } | { error: string } {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return { error: "graph needs nodes: a list of steps." };
  if (raw.connections !== undefined && !Array.isArray(raw.connections)) return { error: "graph.connections must be a list." };
  const parsedNodes: Array<Omit<WorkflowNode, "number" | "x" | "y">> = [];
  for (const [index, node] of raw.nodes.entries()) {
    const parsed = parseNode(node, `nodes[${index}]`);
    if (typeof parsed === "string") return { error: parsed };
    parsedNodes.push(parsed);
  }
  const kindOf = new Map(parsedNodes.map((node) => [node.id, node.kind]));
  const parsedConnections: Array<Omit<WorkflowConnection, "id">> = [];
  for (const [index, connection] of ((raw.connections as unknown[] | undefined) ?? []).entries()) {
    const parsed = parseConnection(connection, `connections[${index}]`, kindOf);
    if (typeof parsed === "string") return { error: parsed };
    parsedConnections.push(parsed);
  }

  const before = new Map((previous?.nodes ?? []).map((node) => [node.id, node]));
  const kept = parsedNodes.flatMap((node) => before.get(node.id) ?? []);
  let nextNumber = Math.max(0, ...kept.map((node) => node.number)) + 1;
  const newRowsFrom = kept.length ? Math.max(...kept.map((node) => node.y)) + ROW_STEP : ROW_Y;
  const depth = depths(parsedNodes.map((node) => node.id), parsedConnections);
  const rowsUsed = new Map<number, number>();
  const nodes = parsedNodes.map((node): WorkflowNode => {
    const old = before.get(node.id);
    if (old) return { ...node, number: old.number, x: old.x, y: old.y };
    const column = depth.get(node.id) ?? 0;
    const row = rowsUsed.get(column) ?? 0;
    rowsUsed.set(column, row + 1);
    return { ...node, number: nextNumber++, x: COLUMN_X + column * COLUMN_STEP, y: newRowsFrom + row * ROW_STEP };
  });

  const oldIds = new Map((previous?.connections ?? []).map((connection) => [`${connection.from}|${sourceKey(connection.source)}|${connection.to}`, connection.id]));
  const connections = parsedConnections.map((connection): WorkflowConnection => ({
    id: oldIds.get(`${connection.from}|${sourceKey(connection.source)}|${connection.to}`) ?? `conn-${randomUUID().slice(0, 8)}`,
    ...connection,
  }));
  return { graph: { nodes, connections } };
}
