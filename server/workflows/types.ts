export const WORKFLOW_THREAD_PREFIX = "wf-slot-";
export const WORKFLOW_MAX_CONCURRENT_TEXT_NODES = 3;
export const WORKFLOW_DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1_000;
export const WORKFLOW_DECISION_TIMEOUT_MS = 3_000;
export const WORKFLOW_DECISION_MAX_STATE_BYTES = 16_000;
export const WORKFLOW_RUNS_MAX_PER_WORKFLOW = 50;

export const DOCUMENT_MAX = 20_000;
export const NODES_MAX = 30;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 20;
export const QUESTION_MAX = 1_000;
export const OPTION_LABEL_MAX = 300;
export const OPTION_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const THRESHOLD_DEFAULT = 0.9;
export const APPROVAL_COMMENT_MAX = 2_000;

export const NODE_KINDS = ["text", "decision", "approval"] as const;
export type WorkflowNodeKind = (typeof NODE_KINDS)[number];

export const APPROVAL_OUTPUTS = ["approve", "reject"] as const;
export type ApprovalOutput = (typeof APPROVAL_OUTPUTS)[number];

export const WORKFLOW_PERMISSIONS = ["full", "edits", "ask"] as const;
export type WorkflowPermission = (typeof WORKFLOW_PERMISSIONS)[number];

export const RUN_STATES = ["queued", "running", "waiting", "done", "failed", "cancelled"] as const;
export type WorkflowRunState = (typeof RUN_STATES)[number];

export const NODE_RUN_STATES = ["pending", "running", "waiting", "done", "failed", "skipped", "cancelled"] as const;
export type WorkflowNodeRunState = (typeof NODE_RUN_STATES)[number];

export interface WorkflowOption {
  id: string;
  label: string;
}

export interface WorkflowNode {
  id: string;
  number: number;
  kind: WorkflowNodeKind;
  name: string;
  prompt: string;
  instanceId: string | null;
  model: string | null;
  effort: string | null;
  permission: WorkflowPermission | null;
  continueOnFailure: boolean;
  question: string;
  threshold: number;
  options: WorkflowOption[];
  x: number;
  y: number;
}

export type WorkflowConnectionSource =
  | { kind: "text" }
  | { kind: "option"; optionId: string }
  | { kind: "verdict"; verdict: ApprovalOutput };

export interface WorkflowConnection {
  id: string;
  from: string;
  to: string;
  source: WorkflowConnectionSource;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

export type WorkflowCheckProblemCode =
  | "too_many_nodes"
  | "duplicate_node_id"
  | "empty_node_name"
  | "too_few_options"
  | "too_many_options"
  | "invalid_option_id"
  | "duplicate_option_id"
  | "option_label_too_long"
  | "question_too_long"
  | "invalid_threshold"
  | "missing_endpoint"
  | "self_loop"
  | "invalid_source"
  | "duplicate_connection"
  | "deadlock";

export interface WorkflowCheckProblem {
  code: WorkflowCheckProblemCode;
  message: string;
  nodeIds: string[];
}

export type WorkflowCheckOutcome =
  | { state: "passed" }
  | { state: "problem"; problems: WorkflowCheckProblem[] };

export interface Workflow {
  id: string;
  name: string;
  document: string;
  folder: string;
  permission: WorkflowPermission;
  graph: WorkflowGraph;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  folder: string;
  permission: WorkflowPermission;
  nodeCount: number;
  running: boolean;
  working: boolean;
  check: "passed" | "problem";
  lastRun: { id: string; state: WorkflowRunState; startedAt: number; endedAt: number | null } | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowNodeRun {
  nodeId: string;
  nodeName: string;
  kind: WorkflowNodeKind;
  state: WorkflowNodeRunState;
  input: string;
  output: string;
  error?: string;
  startedAt: number | null;
  endedAt: number | null;
  chosenOptionId?: string | null;
  probabilities?: Record<string, number>;
  waitReason?: string;
  verdict?: ApprovalOutput | null;
  comment?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  state: WorkflowRunState;
  triggerText: string;
  graph: WorkflowGraph;
  document: string;
  folder: string;
  permission: WorkflowPermission;
  nodes: Record<string, WorkflowNodeRun>;
  waitingNodeId: string | null;
  error?: string;
  startedAt: number;
  endedAt: number | null;
}

export type WorkflowRespondInput =
  | { kind: "approval"; verdict: ApprovalOutput; comment?: string }
  | { kind: "decision"; optionId: string };
