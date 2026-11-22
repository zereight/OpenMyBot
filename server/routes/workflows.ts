import { checkWorkflowGraph } from "../workflows/check.ts";
import type { WorkflowRunner } from "../workflows/runner.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import {
  APPROVAL_OUTPUTS,
  WORKFLOW_PERMISSIONS,
  type ApprovalOutput,
  type WorkflowGraph,
  type WorkflowPermission,
  type WorkflowRespondInput,
} from "../workflows/types.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WorkflowRouteDeps {
  store: WorkflowStore;
  runner: WorkflowRunner;
}

const MAX_BODY_BYTES = 512_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createWorkflowRoutes(deps: WorkflowRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/workflow")) return PASS;

    if (path === "/api/workflows" && method === "GET") {
      return json(res, 200, { workflows: deps.runner.listSummaries() });
    }

    if (path === "/api/workflows" && method === "POST") {
      const body = await readBody(req, MAX_BODY_BYTES);
      if (!isRecord(body)) return json(res, 400, { error: "Invalid request body" });
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return json(res, 400, { error: "Workflow name is required" });
      const document = typeof body.document === "string" ? body.document : undefined;
      const folder = typeof body.folder === "string" ? body.folder : undefined;
      const permission =
        typeof body.permission === "string" && (WORKFLOW_PERMISSIONS as readonly string[]).includes(body.permission)
          ? (body.permission as WorkflowPermission)
          : undefined;
      const graph = isRecord(body.graph) ? (body.graph as unknown as WorkflowGraph) : undefined;
      if (graph) {
        const check = checkWorkflowGraph(graph);
        if (check.state === "problem") return json(res, 400, { error: check.problems[0]?.message ?? "Invalid graph", check });
      }
      const workflow = deps.store.createWorkflow({ name, document, folder, permission, graph });
      return json(res, 201, { workflow, check: checkWorkflowGraph(workflow.graph) });
    }

    const runActionMatch = /^\/api\/workflow-runs\/([\w-]+)\/(cancel|respond)$/.exec(path);
    if (runActionMatch && method === "POST") {
      const [, runId, action] = runActionMatch;
      if (action === "cancel") {
        const result = await deps.runner.cancelRun(runId!);
        if (!result.ok) return json(res, result.status, { error: result.error });
        return json(res, 200, { run: result.run });
      }
      const body = await readBody(req, 32_768);
      if (!isRecord(body)) return json(res, 400, { error: "Invalid request body" });
      let input: WorkflowRespondInput;
      if (body.kind === "approval") {
        if (typeof body.verdict !== "string" || !(APPROVAL_OUTPUTS as readonly string[]).includes(body.verdict)) {
          return json(res, 400, { error: "verdict must be approve or reject" });
        }
        input = {
          kind: "approval",
          verdict: body.verdict as ApprovalOutput,
          ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
        };
      } else if (body.kind === "decision") {
        if (typeof body.optionId !== "string" || !body.optionId.trim()) {
          return json(res, 400, { error: "optionId is required" });
        }
        input = { kind: "decision", optionId: body.optionId.trim() };
      } else {
        return json(res, 400, { error: "kind must be approval or decision" });
      }
      const result = deps.runner.respondToRun(runId!, input);
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { run: result.run });
    }

    const runGetMatch = /^\/api\/workflow-runs\/([\w-]+)$/.exec(path);
    if (runGetMatch && method === "GET") {
      const run = deps.store.getRun(runGetMatch[1]!);
      if (!run) return json(res, 404, { error: "Run not found" });
      return json(res, 200, { run });
    }

    const wfSubMatch = /^\/api\/workflows\/([\w-]+)\/(check|runs)$/.exec(path);
    if (wfSubMatch) {
      const [, workflowId, sub] = wfSubMatch;
      if (sub === "check" && method === "POST") {
        const body = await readBody(req, MAX_BODY_BYTES).catch(() => null);
        if (isRecord(body) && isRecord(body.graph)) {
          return json(res, 200, { check: checkWorkflowGraph(body.graph as unknown as WorkflowGraph) });
        }
        const workflow = deps.store.getWorkflow(workflowId!);
        if (!workflow) return json(res, 404, { error: "Workflow not found" });
        return json(res, 200, { check: checkWorkflowGraph(workflow.graph) });
      }
      if (sub === "runs" && method === "GET") {
        const workflow = deps.store.getWorkflow(workflowId!);
        if (!workflow) return json(res, 404, { error: "Workflow not found" });
        return json(res, 200, { runs: deps.store.listRuns(workflowId!) });
      }
      if (sub === "runs" && method === "POST") {
        const body = await readBody(req, 65_536).catch(() => null);
        const triggerText = isRecord(body) && typeof body.triggerText === "string" ? body.triggerText : "";
        const result = deps.runner.startRun(workflowId!, triggerText);
        if (!result.ok) return json(res, result.status, { error: result.error });
        return json(res, 201, { run: result.run });
      }
    }

    const wfMatch = /^\/api\/workflows\/([\w-]+)$/.exec(path);
    if (wfMatch) {
      const workflowId = wfMatch[1]!;
      if (method === "GET") {
        const workflow = deps.store.getWorkflow(workflowId);
        if (!workflow) return json(res, 404, { error: "Workflow not found" });
        return json(res, 200, {
          workflow,
          check: checkWorkflowGraph(workflow.graph),
          runs: deps.store.listRuns(workflowId),
          running: deps.runner.isWorkflowRunning(workflowId),
        });
      }
      if (method === "PATCH") {
        if (deps.runner.isWorkflowRunning(workflowId)) {
          return json(res, 409, { error: "Cannot edit a workflow while a run is active or waiting." });
        }
        const body = await readBody(req, MAX_BODY_BYTES);
        if (!isRecord(body)) return json(res, 400, { error: "Invalid request body" });
        const patch: {
          name?: string;
          document?: string;
          folder?: string;
          permission?: WorkflowPermission;
          graph?: WorkflowGraph;
        } = {};
        if (typeof body.name === "string") patch.name = body.name;
        if (typeof body.document === "string") patch.document = body.document;
        if (typeof body.folder === "string") patch.folder = body.folder;
        if (typeof body.permission === "string") {
          if (!(WORKFLOW_PERMISSIONS as readonly string[]).includes(body.permission)) {
            return json(res, 400, { error: "Invalid permission level" });
          }
          patch.permission = body.permission as WorkflowPermission;
        }
        if (isRecord(body.graph)) {
          const graph = body.graph as unknown as WorkflowGraph;
          const check = checkWorkflowGraph(graph);
          if (check.state === "problem") {
            return json(res, 400, { error: check.problems[0]?.message ?? "Graph check failed", check });
          }
          patch.graph = graph;
        }
        const updated = deps.store.updateWorkflow(workflowId, patch);
        if (!updated) return json(res, 404, { error: "Workflow not found" });
        return json(res, 200, { workflow: updated, check: checkWorkflowGraph(updated.graph) });
      }
      if (method === "DELETE") {
        if (deps.runner.isWorkflowRunning(workflowId)) {
          return json(res, 409, { error: "Cannot delete a workflow while a run is active or waiting." });
        }
        const deleted = deps.store.deleteWorkflow(workflowId);
        if (!deleted) return json(res, 404, { error: "Workflow not found" });
        return json(res, 200, { ok: true });
      }
    }

    return PASS;
  };
}
