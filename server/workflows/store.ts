import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCUMENT_MAX,
  THRESHOLD_DEFAULT,
  WORKFLOW_PERMISSIONS,
  WORKFLOW_RUNS_MAX_PER_WORKFLOW,
  type Workflow,
  type WorkflowGraph,
  type WorkflowPermission,
  type WorkflowRun,
} from "./types.ts";

const DEFAULT_DOCUMENT =
  "You are responsible for running this workflow accurately and concisely. Follow each step's prompt and keep outputs structured for downstream steps.";

function atomicWriteJson(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface WorkflowStore {
  listWorkflows(): Workflow[];
  getWorkflow(id: string): Workflow | null;
  createWorkflow(input: {
    name: string;
    document?: string;
    folder?: string;
    permission?: WorkflowPermission;
    graph?: WorkflowGraph;
  }): Workflow;
  updateWorkflow(
    id: string,
    patch: Partial<Pick<Workflow, "name" | "document" | "folder" | "permission" | "graph">>,
  ): Workflow | null;
  deleteWorkflow(id: string): boolean;
  ensureWorkspaceDir(workflow: Workflow): string;
  listRuns(workflowId: string): WorkflowRun[];
  getRun(runId: string): WorkflowRun | null;
  saveRun(run: WorkflowRun): void;
  recoverInterruptedRuns(): number;
}

export function createWorkflowStore(dataDir: string): WorkflowStore {
  const rootDir = join(dataDir, "workflows");
  const workflowsFile = join(rootDir, "workflows.json");
  const runsRoot = join(rootDir, "runs");
  const workspacesRoot = join(rootDir, "workspaces");

  mkdirSync(rootDir, { recursive: true });
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });

  let workflows: Workflow[] = readJsonFile<Workflow[]>(workflowsFile) ?? [];
  const runIndex = new Map<string, string>();

  function rebuildRunIndex(): void {
    runIndex.clear();
    if (!existsSync(runsRoot)) return;
    for (const wfEntry of readdirSync(runsRoot)) {
      const wfDir = join(runsRoot, wfEntry);
      if (!statSync(wfDir).isDirectory()) continue;
      for (const file of readdirSync(wfDir)) {
        if (!file.endsWith(".json")) continue;
        const runId = file.slice(0, -5);
        runIndex.set(runId, join(wfDir, file));
      }
    }
  }

  rebuildRunIndex();

  function persistWorkflows(): void {
    atomicWriteJson(workflowsFile, workflows);
  }

  function starterGraph(): WorkflowGraph {
    return {
      nodes: [
        {
          id: `node-${randomUUID().slice(0, 8)}`,
          number: 1,
          kind: "text",
          name: "Step 1",
          prompt: "Process the request:\n\n{{trigger}}",
          instanceId: null,
          model: null,
          effort: null,
          permission: null,
          continueOnFailure: false,
          question: "",
          threshold: THRESHOLD_DEFAULT,
          options: [],
          x: 80,
          y: 120,
        },
      ],
      connections: [],
    };
  }

  function workflowRunsDir(workflowId: string): string {
    const dir = join(runsRoot, workflowId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function trimOldRuns(workflowId: string): void {
    const runs = listRuns(workflowId);
    if (runs.length <= WORKFLOW_RUNS_MAX_PER_WORKFLOW) return;
    const toRemove = runs.slice(WORKFLOW_RUNS_MAX_PER_WORKFLOW);
    for (const run of toRemove) {
      if (run.state === "running" || run.state === "queued" || run.state === "waiting") continue;
      const path = runIndex.get(run.id);
      if (path && existsSync(path)) {
        rmSync(path, { force: true });
      }
      runIndex.delete(run.id);
    }
  }

  function listRuns(workflowId: string): WorkflowRun[] {
    const dir = join(runsRoot, workflowId);
    if (!existsSync(dir)) return [];
    const results: WorkflowRun[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const run = readJsonFile<WorkflowRun>(join(dir, file));
      if (run) results.push(run);
    }
    results.sort((a, b) => b.startedAt - a.startedAt);
    return results;
  }

  function getRun(runId: string): WorkflowRun | null {
    const path = runIndex.get(runId);
    if (!path) return null;
    return readJsonFile<WorkflowRun>(path);
  }

  function saveRun(run: WorkflowRun): void {
    const dir = workflowRunsDir(run.workflowId);
    const filePath = join(dir, `${run.id}.json`);
    atomicWriteJson(filePath, run);
    runIndex.set(run.id, filePath);
    trimOldRuns(run.workflowId);
  }

  return {
    listWorkflows() {
      return workflows.map((workflow) => structuredClone(workflow));
    },
    getWorkflow(id) {
      const found = workflows.find((workflow) => workflow.id === id);
      return found ? structuredClone(found) : null;
    },
    createWorkflow(input) {
      const now = Date.now();
      const id = `wf-${randomUUID().slice(0, 12)}`;
      const permission =
        input.permission && (WORKFLOW_PERMISSIONS as readonly string[]).includes(input.permission)
          ? input.permission
          : "full";
      const workflow: Workflow = {
        id,
        name: input.name.trim() || "Untitled workflow",
        document: (input.document ?? DEFAULT_DOCUMENT).slice(0, DOCUMENT_MAX),
        folder: (input.folder ?? "").trim(),
        permission,
        graph: input.graph ? structuredClone(input.graph) : starterGraph(),
        createdAt: now,
        updatedAt: now,
      };
      workflows = [workflow, ...workflows];
      persistWorkflows();
      return structuredClone(workflow);
    },
    updateWorkflow(id, patch) {
      const idx = workflows.findIndex((workflow) => workflow.id === id);
      if (idx === -1) return null;
      const current = workflows[idx]!;
      const next: Workflow = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
        ...(patch.document !== undefined ? { document: patch.document.slice(0, DOCUMENT_MAX) } : {}),
        ...(patch.folder !== undefined ? { folder: patch.folder.trim() } : {}),
        ...(patch.permission !== undefined && (WORKFLOW_PERMISSIONS as readonly string[]).includes(patch.permission)
          ? { permission: patch.permission }
          : {}),
        ...(patch.graph !== undefined ? { graph: structuredClone(patch.graph) } : {}),
        updatedAt: Date.now(),
      };
      workflows[idx] = next;
      persistWorkflows();
      return structuredClone(next);
    },
    deleteWorkflow(id) {
      const before = workflows.length;
      workflows = workflows.filter((workflow) => workflow.id !== id);
      if (workflows.length === before) return false;
      persistWorkflows();
      const wfRunDir = join(runsRoot, id);
      if (existsSync(wfRunDir)) rmSync(wfRunDir, { recursive: true, force: true });
      for (const [runId, filePath] of runIndex) {
        if (filePath.startsWith(wfRunDir)) runIndex.delete(runId);
      }
      return true;
    },
    ensureWorkspaceDir(workflow) {
      if (workflow.folder) {
        if (!existsSync(workflow.folder) || !statSync(workflow.folder).isDirectory()) {
          throw new Error(`Workflow folder does not exist: ${workflow.folder}`);
        }
        return workflow.folder;
      }
      const dir = join(workspacesRoot, workflow.id);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    listRuns,
    getRun,
    saveRun,
    recoverInterruptedRuns() {
      let recovered = 0;
      const now = Date.now();
      for (const [, filePath] of runIndex) {
        const run = readJsonFile<WorkflowRun>(filePath);
        if (!run) continue;
        if (run.state !== "running" && run.state !== "queued") continue;
        for (const nodeRun of Object.values(run.nodes)) {
          if (nodeRun.state === "running") {
            nodeRun.state = "failed";
            nodeRun.error = "Server restarted while running";
            nodeRun.endedAt = now;
          }
        }
        run.state = "failed";
        run.error = "Server restarted while running";
        run.endedAt = now;
        atomicWriteJson(filePath, run);
        recovered++;
      }
      return recovered;
    },
  };
}
