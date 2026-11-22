import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

import { levelWithin, type ApprovalMode } from "../../shared/approval-mode.ts";
import { WORKFLOW_DELETE_PATH, WORKFLOW_EDIT_PATH, WORKFLOW_INFO_PATH } from "../drivers/agents-workflow-tools.ts";
import { checkWorkflowGraph } from "../workflows/check.ts";
import { graphFromSpec, specFromGraph } from "../workflows/graph-spec.ts";
import type { WorkflowRunner } from "../workflows/runner.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import { WORKFLOW_PERMISSIONS, type Workflow, type WorkflowGraph, type WorkflowPermission, type WorkflowRun } from "../workflows/types.ts";
import type { HelperToolContext } from "./helper-tools.ts";
import { PASS } from "./table.ts";

export const WORKFLOWS_GUEST = "Workflows belong to the owner of this computer, and this conversation was started by someone else.";
export const WORKFLOWS_ADMIN = "Only the workspace owner or an admin can use Workflows.";
const SEE_IT = "The person sees it under Workflows in the sidebar.";
const OUTPUT_SHOWN = 4_000;
const RUNS_SHOWN = 5;

export interface InternalWorkflowDeps {
  store: WorkflowStore;
  runner: WorkflowRunner;
  approvalLevel(botId: string, threadId: string): ApprovalMode;
  guestDriven(threadId: string): boolean;
  assertWithinBudget?: () => void;
}

type Answer = { status: number; body: { text: string } | { error: string } };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const ok = (view: unknown): Answer => ({ status: 200, body: { text: JSON.stringify(view) } });
const refuse = (status: number, error: string): Answer => ({ status, body: { error } });

function problemsOf(graph: WorkflowGraph) {
  const check = checkWorkflowGraph(graph);
  return check.state === "passed" ? [] : check.problems.map((problem) => ({ code: problem.code, message: problem.message, steps: problem.nodeIds }));
}

function workflowView(workflow: Workflow, runs: WorkflowRun[]) {
  return {
    id: workflow.id,
    name: workflow.name,
    folder: workflow.folder || null,
    permission: workflow.permission,
    document: workflow.document,
    graph: specFromGraph(workflow.graph),
    problems: problemsOf(workflow.graph),
    runs: runs.slice(0, RUNS_SHOWN).map((run) => ({ id: run.id, state: run.state, started_at: new Date(run.startedAt).toISOString() })),
  };
}

function runView(run: WorkflowRun) {
  const clip = (value: string) => (value.length > OUTPUT_SHOWN ? `${value.slice(0, OUTPUT_SHOWN)}… (${value.length - OUTPUT_SHOWN} more characters in Workflows)` : value);
  return {
    id: run.id,
    workflow_id: run.workflowId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    ...(run.waitingNodeId ? { waiting_on: run.waitingNodeId, waiting_note: "Only the person answers this, in Workflows." } : {}),
    steps: run.graph.nodes.map((node) => {
      const step = run.nodes[node.id];
      return {
        id: node.id,
        name: node.name,
        state: step?.state ?? "pending",
        ...(step?.output ? { output: clip(step.output) } : {}),
        ...(step?.error ? { error: step.error } : {}),
        ...(step?.chosenOptionId ? { chose: step.chosenOptionId } : {}),
        ...(step?.verdict ? { verdict: step.verdict } : {}),
      };
    }),
  };
}

function levelAbove(permission: WorkflowPermission, graph: WorkflowGraph, limit: ApprovalMode): WorkflowPermission | null {
  const levels = [permission, ...graph.nodes.filter((node) => node.kind === "text").map((node) => node.permission ?? permission)];
  return levels.find((level) => !levelWithin(level, limit)) ?? null;
}

const aboveYou = (level: WorkflowPermission, limit: ApprovalMode) =>
  `A step would run at ${level}, above your own approval level here (${limit}). Use a lower permission, or ask the person to change it in Workflows.`;

const defaultPermission = (limit: ApprovalMode): WorkflowPermission =>
  limit === "full" ? "full" : limit === "edits" ? "edits" : "ask";

function withinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function folderProblem(folder: string, roots: readonly string[]): string | null {
  if (!folder) return null;
  try {
    if (!isAbsolute(folder)) return `folder must be "" or an existing absolute folder inside your working folders; ${folder} is not absolute.`;
    const real = realpathSync(folder);
    if (!statSync(real).isDirectory()) return `folder must be an existing directory; ${folder} is not one.`;
    const allowed = roots.some((root) => {
      try {
        return withinRoot(real, realpathSync(root));
      } catch {
        return false;
      }
    });
    if (allowed) return null;
    return `folder must be "" (the workflow's own folder) or inside your working folders; ask the person to set another folder in Workflows.`;
  } catch {
    return `folder must be an existing absolute folder inside your working folders, or "" for the workflow's own; ${folder} is not one.`;
  }
}

export function createInternalWorkflowRoutes(deps: InternalWorkflowDeps) {
  function info(body: Record<string, unknown>): Answer {
    const runId = text(body.run_id);
    if (runId) {
      const run = deps.store.getRun(runId);
      return run ? ok(runView(run)) : refuse(404, `No run ${runId}. workflow_info with a workflow_id lists its runs.`);
    }
    const workflowId = text(body.workflow_id);
    if (workflowId) {
      const workflow = deps.store.getWorkflow(workflowId);
      return workflow ? ok(workflowView(workflow, deps.store.listRuns(workflowId))) : refuse(404, `No workflow ${workflowId}. workflow_info with no ids lists them.`);
    }
    return ok({
      workflows: deps.runner.listSummaries().map((summary) => ({
        id: summary.id,
        name: summary.name,
        steps: summary.nodeCount,
        check: summary.check,
        running: summary.running,
        ...(summary.lastRun ? { last_run: { id: summary.lastRun.id, state: summary.lastRun.state } } : {}),
      })),
      note: SEE_IT,
    });
  }

  function save(body: Record<string, unknown>, limit: ApprovalMode, current: Workflow | null, roots: readonly string[]): Answer {
    if (body.permission !== undefined && !(WORKFLOW_PERMISSIONS as readonly unknown[]).includes(body.permission)) return refuse(400, "permission must be full, edits or ask.");
    if (body.folder !== undefined && typeof body.folder !== "string") return refuse(400, "folder must be a path, or \"\" for the workflow's own folder.");
    const folder = typeof body.folder === "string" ? body.folder.trim() : undefined;
    const problem = folder === undefined ? null : folderProblem(folder, roots);
    if (problem) return refuse(400, problem);
    let graph: WorkflowGraph | undefined;
    if (body.graph !== undefined) {
      const parsed = graphFromSpec(body.graph, current?.graph ?? null);
      if ("error" in parsed) return refuse(400, parsed.error);
      const problems = problemsOf(parsed.graph);
      if (problems.length) return refuse(400, `Not saved: ${problems.map((one) => one.message).join(" ")}`);
      graph = parsed.graph;
    }
    const permission = (body.permission as WorkflowPermission | undefined) ?? current?.permission ?? defaultPermission(limit);
    const above = levelAbove(permission, graph ?? current?.graph ?? { nodes: [], connections: [] }, limit);
    if (above) return refuse(403, aboveYou(above, limit));
    const fields = {
      ...(text(body.name) ? { name: text(body.name)! } : {}),
      ...(typeof body.document === "string" ? { document: body.document } : {}),
      ...(folder !== undefined ? { folder } : {}),
      ...(body.permission !== undefined ? { permission } : {}),
      ...(graph ? { graph } : {}),
    };
    if (!current) {
      if (!fields.name) return refuse(400, "create needs a name.");
      return ok({ saved: workflowView(deps.store.createWorkflow({ ...fields, name: fields.name, permission }), []), note: SEE_IT });
    }
    const updated = deps.store.updateWorkflow(current.id, fields);
    return updated ? ok({ saved: workflowView(updated, deps.store.listRuns(updated.id)), note: SEE_IT }) : refuse(404, `No workflow ${current.id}.`);
  }

  async function edit(body: Record<string, unknown>, limit: ApprovalMode, roots: readonly string[]): Promise<Answer> {
    const action = body.action;
    if (action === "create") return save(body, limit, null, roots);
    if (action === "cancel") {
      const runId = text(body.run_id);
      if (!runId) return refuse(400, "cancel needs run_id.");
      const existingRun = deps.store.getRun(runId);
      if (!existingRun) return refuse(404, `No run ${runId}.`);
      const runAbove = levelAbove(existingRun.permission, existingRun.graph, limit);
      if (runAbove) return refuse(403, aboveYou(runAbove, limit));
      const result = await deps.runner.cancelRun(runId);
      return result.ok ? ok(runView(result.run)) : refuse(result.status, result.error);
    }
    const workflowId = text(body.workflow_id);
    if (!workflowId) return refuse(400, `${String(action)} needs workflow_id, from workflow_info.`);
    const workflow = deps.store.getWorkflow(workflowId);
    if (!workflow) return refuse(404, `No workflow ${workflowId}. workflow_info with no ids lists them.`);
    const existingAbove = levelAbove(workflow.permission, workflow.graph, limit);
    if (existingAbove) return refuse(403, aboveYou(existingAbove, limit));
    if (action === "update") {
      if (deps.runner.isWorkflowRunning(workflow.id)) return refuse(409, "That workflow has a run going or waiting; cancel it or wait for it to end, then change it.");
      return save(body, limit, workflow, roots);
    }
    if (action !== "run") return refuse(400, "action must be create, update, run or cancel.");
    if (deps.runner.isWorkflowRunning(workflow.id)) return refuse(409, "That workflow already has a run going or waiting.");
    try {
      deps.assertWithinBudget?.();
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 402;
      return refuse(status, error instanceof Error ? error.message : "Usage budget reached.");
    }
    const started = deps.runner.startRun(workflow.id, typeof body.input === "string" ? body.input : "");
    return started.ok
      ? ok({ started: { run_id: started.run.id, state: started.run.state }, note: `It runs on its own. workflow_info with run_id ${started.run.id} shows how it is going. ${SEE_IT}` })
      : refuse(started.status, started.error);
  }

  function remove(body: Record<string, unknown>, limit: ApprovalMode): Answer {
    const workflowId = text(body.workflow_id);
    if (!workflowId) return refuse(400, "delete_workflow needs workflow_id.");
    const workflow = deps.store.getWorkflow(workflowId);
    if (!workflow) return refuse(404, `No workflow ${workflowId}.`);
    const above = levelAbove(workflow.permission, workflow.graph, limit);
    if (above) return refuse(403, aboveYou(above, limit));
    if (deps.runner.isWorkflowRunning(workflowId)) return refuse(409, "That workflow has a run going or waiting; cancel it first.");
    return deps.store.deleteWorkflow(workflowId) ? ok({ deleted: workflowId }) : refuse(404, `No workflow ${workflowId}.`);
  }

  return async (ctx: HelperToolContext & { threadId: string; actsForAdmin?: boolean }): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || (ctx.path !== WORKFLOW_INFO_PATH && ctx.path !== WORKFLOW_EDIT_PATH && ctx.path !== WORKFLOW_DELETE_PATH)) return PASS;
    if (deps.guestDriven(ctx.threadId)) return void ctx.json(ctx.res, 403, { error: WORKFLOWS_GUEST });
    if (ctx.actsForAdmin === false) return void ctx.json(ctx.res, 403, { error: WORKFLOWS_ADMIN });
    const body = await ctx.readBody();
    if (!isRecord(body)) return void ctx.json(ctx.res, 400, { error: "Send the tool's arguments as an object." });
    const limit = deps.approvalLevel(ctx.botId, ctx.threadId);
    const roots = ctx.path === WORKFLOW_EDIT_PATH ? (await ctx.folders()).roots : [];
    const answer =
      ctx.path === WORKFLOW_INFO_PATH ? info(body)
        : ctx.path === WORKFLOW_DELETE_PATH ? remove(body, limit)
          : await edit(body, limit, roots);
    return void ctx.json(ctx.res, answer.status, answer.body);
  };
}
