import type {
  ApprovalOutput,
  Workflow,
  WorkflowCheckOutcome,
  WorkflowConnection,
  WorkflowConnectionSource,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeRun,
  WorkflowOption,
  WorkflowPermission,
  WorkflowRespondInput,
  WorkflowRun,
  WorkflowRunState,
  WorkflowSummary,
} from "../../server/workflows/types";

export type {
  ApprovalOutput,
  Workflow,
  WorkflowCheckOutcome,
  WorkflowConnection,
  WorkflowConnectionSource,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeRun,
  WorkflowOption,
  WorkflowPermission,
  WorkflowRespondInput,
  WorkflowRun,
  WorkflowRunState,
  WorkflowSummary,
};

export interface WorkflowDetailResponse {
  workflow: Workflow;
  check: WorkflowCheckOutcome;
  runs: WorkflowRun[];
  running: boolean;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const data = await requestJson<{ workflows: WorkflowSummary[] }>("/api/workflows");
  return data.workflows;
}

export async function getWorkflowDetail(id: string): Promise<WorkflowDetailResponse> {
  return requestJson<WorkflowDetailResponse>(`/api/workflows/${encodeURIComponent(id)}`);
}

export async function createWorkflow(input: {
  name: string;
  document?: string;
  folder?: string;
  permission?: WorkflowPermission;
}): Promise<{ workflow: Workflow; check: WorkflowCheckOutcome }> {
  return requestJson("/api/workflows", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkflow(
  id: string,
  patch: Partial<Pick<Workflow, "name" | "document" | "folder" | "permission" | "graph">>,
): Promise<{ workflow: Workflow; check: WorkflowCheckOutcome }> {
  return requestJson(`/api/workflows/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteWorkflow(id: string): Promise<void> {
  await requestJson(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function checkWorkflowDraft(id: string, graph: WorkflowGraph): Promise<WorkflowCheckOutcome> {
  const data = await requestJson<{ check: WorkflowCheckOutcome }>(`/api/workflows/${encodeURIComponent(id)}/check`, {
    method: "POST",
    body: JSON.stringify({ graph }),
  });
  return data.check;
}

export async function startWorkflowRun(id: string, triggerText: string): Promise<WorkflowRun> {
  const data = await requestJson<{ run: WorkflowRun }>(`/api/workflows/${encodeURIComponent(id)}/runs`, {
    method: "POST",
    body: JSON.stringify({ triggerText }),
  });
  return data.run;
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  const data = await requestJson<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(runId)}`);
  return data.run;
}

export async function cancelWorkflowRun(runId: string): Promise<WorkflowRun> {
  const data = await requestJson<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  return data.run;
}

export async function respondWorkflowRun(runId: string, input: WorkflowRespondInput): Promise<WorkflowRun> {
  const data = await requestJson<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(runId)}/respond`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.run;
}
