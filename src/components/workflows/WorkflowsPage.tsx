import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Play, Plus, Save, Trash2 } from "lucide-react";
import { Select } from "@/components/Select";
import { useStore } from "@/state/store";
import {
  cancelWorkflowRun,
  checkWorkflowDraft,
  createWorkflow,
  deleteWorkflow,
  getWorkflowDetail,
  getWorkflowRun,
  listWorkflows,
  respondWorkflowRun,
  startWorkflowRun,
  updateWorkflow,
  type Workflow,
  type WorkflowCheckOutcome,
  type WorkflowConnectionSource,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowPermission,
  type WorkflowRespondInput,
  type WorkflowRun,
  type WorkflowSummary,
} from "@/lib/workflows-api";
import { cn } from "@/lib/cn";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowNodeInspector } from "./WorkflowNodeInspector";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel";

type TabKey = "editor" | "runs" | "document";

export function WorkflowsPage() {
  const { state } = useStore();
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftFolder, setDraftFolder] = useState("");
  const [draftPermission, setDraftPermission] = useState<WorkflowPermission>("full");
  const [draftDocument, setDraftDocument] = useState("");
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph>({ nodes: [], connections: [] });
  const [dirty, setDirty] = useState(false);
  const [check, setCheck] = useState<WorkflowCheckOutcome>({ state: "passed" });
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("editor");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const instances = useMemo(
    () =>
      state.instances.map((inst) => ({
        instanceId: inst.instanceId,
        label: inst.displayName || inst.instanceId,
      })),
    [state.instances],
  );

  const refreshList = useCallback(async (selectFallback = false) => {
    try {
      const list = await listWorkflows();
      setSummaries(list);
      if (selectFallback && !selectedId && list[0]) {
        setSelectedId(list[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflows");
    }
  }, [selectedId]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const detail = await getWorkflowDetail(id);
      setWorkflow(detail.workflow);
      setDraftName(detail.workflow.name);
      setDraftFolder(detail.workflow.folder);
      setDraftPermission(detail.workflow.permission);
      setDraftDocument(detail.workflow.document);
      setDraftGraph(detail.workflow.graph);
      setCheck(detail.check);
      setRuns(detail.runs);
      setRunning(detail.running);
      setDirty(false);
      setSelectedNodeId((prev) =>
        prev && detail.workflow.graph.nodes.some((n) => n.id === prev) ? prev : detail.workflow.graph.nodes[0]?.id ?? null,
      );
      setSelectedRunId((prev) => (prev && detail.runs.some((r) => r.id === prev) ? prev : detail.runs[0]?.id ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow");
    }
  }, []);

  useEffect(() => {
    void refreshList(true);
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setWorkflow(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const activeRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  useEffect(() => {
    const pollRun = runs.find((run) => run.state === "queued" || run.state === "running");
    if (!pollRun) return;
    const timer = setInterval(() => {
      void getWorkflowRun(pollRun.id)
        .then((latest) => {
          setRuns((prev) => prev.map((item) => (item.id === latest.id ? latest : item)));
          if (latest.state !== "queued" && latest.state !== "running") {
            setRunning(latest.state === "waiting");
            void refreshList();
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [runs, refreshList]);

  const problemNodeIds = useMemo(() => {
    if (check.state !== "problem") return new Set<string>();
    return new Set(check.problems.flatMap((problem) => problem.nodeIds));
  }, [check]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createWorkflow({ name: trimmed });
      setNewName("");
      await refreshList();
      setSelectedId(created.workflow.id);
      setTab("editor");
      setNotice("Workflow created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workflow");
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!workflow) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updateWorkflow(workflow.id, {
        name: draftName,
        folder: draftFolder,
        permission: draftPermission,
        document: draftDocument,
        graph: draftGraph,
      });
      setWorkflow(saved.workflow);
      setCheck(saved.check);
      setDirty(false);
      setNotice("Saved.");
      await refreshList();
    } catch (err) {
      const checked = await checkWorkflowDraft(workflow.id, draftGraph).catch(() => null);
      if (checked) setCheck(checked);
      setError(err instanceof Error ? err.message : "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!workflow) return;
    setError(null);
    try {
      await deleteWorkflow(workflow.id);
      setSelectedId(null);
      setWorkflow(null);
      await refreshList(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete workflow");
    }
  };

  const addNode = (kind: WorkflowNodeKind) => {
    if (running) return;
    const nextNumber = draftGraph.nodes.reduce((max, item) => Math.max(max, item.number), 0) + 1;
    const id = `node-${Date.now().toString(36)}-${nextNumber}`;
    const x = 80 + ((nextNumber - 1) % 3) * 280;
    const y = 80 + Math.floor((nextNumber - 1) / 3) * 140;
    const node: WorkflowNode = {
      id,
      number: nextNumber,
      kind,
      name: kind === "text" ? `Step ${nextNumber}` : kind === "decision" ? `Decision ${nextNumber}` : `Approval ${nextNumber}`,
      prompt: kind === "text" ? "Continue with:\n\n{{input}}" : "",
      instanceId: null,
      model: null,
      effort: null,
      permission: null,
      continueOnFailure: false,
      question: kind === "approval" ? "Approve to continue?" : kind === "decision" ? "Choose the next path." : "",
      threshold: 0.9,
      options:
        kind === "decision"
          ? [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ]
          : [],
      x,
      y,
    };
    setDraftGraph((prev) => ({ ...prev, nodes: [...prev.nodes, node] }));
    setSelectedNodeId(id);
    setDirty(true);
  };

  const updateNode = (nodeId: string, patch: Partial<WorkflowNode>) => {
    setDraftGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((item) => (item.id === nodeId ? { ...item, ...patch } : item)),
    }));
    setDirty(true);
  };

  const removeNode = (nodeId: string) => {
    setDraftGraph((prev) => ({
      nodes: prev.nodes.filter((item) => item.id !== nodeId),
      connections: prev.connections.filter((conn) => conn.from !== nodeId && conn.to !== nodeId),
    }));
    setSelectedNodeId(null);
    setDirty(true);
  };

  const addConnection = (fromId: string, toId: string, source: WorkflowConnectionSource) => {
    if (fromId === toId) return;
    const id = `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setDraftGraph((prev) => ({
      ...prev,
      connections: [...prev.connections, { id, from: fromId, to: toId, source }],
    }));
    setDirty(true);
  };

  const removeConnection = (connectionId: string) => {
    setDraftGraph((prev) => ({
      ...prev,
      connections: prev.connections.filter((conn) => conn.id !== connectionId),
    }));
    setDirty(true);
  };

  const handleStartRun = async (triggerText: string) => {
    if (!workflow) return;
    if (dirty) {
      setError("Save your changes before running the workflow.");
      return;
    }
    setStartingRun(true);
    setError(null);
    try {
      const run = await startWorkflowRun(workflow.id, triggerText);
      setRuns((prev) => [run, ...prev]);
      setSelectedRunId(run.id);
      setRunning(true);
      setTab("runs");
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setStartingRun(false);
    }
  };

  const handleCancelRun = async (runId: string) => {
    try {
      const updated = await cancelWorkflowRun(runId);
      setRuns((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setRunning(false);
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel run");
    }
  };

  const handleRespondRun = async (runId: string, input: WorkflowRespondInput) => {
    try {
      const updated = await respondWorkflowRun(runId, input);
      setRuns((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setRunning(updated.state === "running" || updated.state === "waiting" || updated.state === "queued");
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit response");
    }
  };

  const selectedNode = draftGraph.nodes.find((item) => item.id === selectedNodeId) ?? null;

  return (
    <main className="flex h-full min-w-0 flex-1 overflow-hidden bg-app text-ink">
      <aside className="flex w-64 shrink-0 flex-col border-r border-hairline/40 bg-app">
        <div className="border-b border-hairline/40 p-3">
          <h1 className="text-[14px] font-semibold text-ink">Workflows</h1>
          <form onSubmit={handleCreate} className="mt-2 flex items-center gap-1.5">
            <input
              type="text"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="New workflow name…"
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              aria-label="Create workflow"
              className="rounded-lg bg-accent p-1.5 text-white hover:opacity-90 disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </form>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {summaries.length === 0 ? (
            <p className="p-2 text-[12px] text-ink-secondary">Create your first workflow above.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {summaries.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors",
                    selectedId === item.id
                      ? "border-accent bg-accent/10 text-ink"
                      : "border-transparent hover:bg-raised text-ink-secondary",
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[13px] font-medium text-ink">{item.name}</span>
                    {item.check === "passed" ? (
                      <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
                    ) : (
                      <AlertTriangle size={12} className="shrink-0 text-rose-500" />
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-ink-secondary">
                    <span>{item.nodeCount} nodes</span>
                    <span>{item.running ? "active" : item.lastRun?.state ?? "idle"}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!workflow ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary">
            Select or create a workflow to open the graph editor.
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline/40 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  type="text"
                  disabled={running}
                  value={draftName}
                  onChange={(event) => {
                    setDraftName(event.target.value);
                    setDirty(true);
                  }}
                  className="min-w-0 rounded-md bg-transparent px-1.5 py-0.5 text-[15px] font-semibold text-ink outline-none focus:bg-inset"
                />
                <Select
                  size="sm"
                  disabled={running}
                  value={draftPermission}
                  onChange={(event) => {
                    setDraftPermission(event.target.value as WorkflowPermission);
                    setDirty(true);
                  }}
                >
                  <option value="full">Full access</option>
                  <option value="edits">Edits only</option>
                  <option value="ask">Ask</option>
                </Select>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={saving || running || !dirty}
                  onClick={handleSave}
                  className="inline-flex items-center gap-1 rounded-lg bg-control px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40"
                >
                  <Save size={13} />
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={startingRun || dirty}
                  onClick={() => void handleStartRun("")}
                  className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  <Play size={13} />
                  Run
                </button>
                <button
                  type="button"
                  disabled={running}
                  onClick={handleDelete}
                  aria-label="Delete workflow"
                  className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-500/10 disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </header>

            <div className="flex items-center justify-between border-b border-hairline/40 px-4 py-1.5 text-[12px]">
              <div className="flex items-center gap-1">
                {(["editor", "runs", "document"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className={cn(
                      "rounded-md px-2.5 py-1 capitalize transition-colors",
                      tab === key ? "bg-control font-medium text-ink" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {key}
                  </button>
                ))}
              </div>
              {tab === "editor" && !running && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => addNode("text")}
                    className="rounded-md bg-control px-2 py-1 text-[11px] font-medium text-ink hover:bg-raised"
                  >
                    + Text
                  </button>
                  <button
                    type="button"
                    onClick={() => addNode("decision")}
                    className="rounded-md bg-control px-2 py-1 text-[11px] font-medium text-ink hover:bg-raised"
                  >
                    + Decision
                  </button>
                  <button
                    type="button"
                    onClick={() => addNode("approval")}
                    className="rounded-md bg-control px-2 py-1 text-[11px] font-medium text-ink hover:bg-raised"
                  >
                    + Approval
                  </button>
                </div>
              )}
            </div>

            {(error || notice || check.state === "problem") && (
              <div className="flex flex-col gap-1 border-b border-hairline/40 px-4 py-2 text-[12px]">
                {error && <div className="text-rose-500">{error}</div>}
                {notice && <div className="text-emerald-500">{notice}</div>}
                {check.state === "problem" && (
                  <div className="text-rose-500">
                    Graph check failed: {check.problems.map((p) => p.message).join(" · ")}
                  </div>
                )}
              </div>
            )}

            {tab === "editor" && (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <WorkflowCanvas
                  graph={draftGraph}
                  selectedNodeId={selectedNodeId}
                  problemNodeIds={problemNodeIds}
                  nodeRuns={activeRun?.nodes}
                  readOnly={running}
                  onSelectNode={setSelectedNodeId}
                  onMoveNode={(nodeId, x, y) => updateNode(nodeId, { x, y })}
                  onConnect={addConnection}
                  onDeleteConnection={removeConnection}
                />
                {selectedNode && (
                  <WorkflowNodeInspector
                    node={selectedNode}
                    graph={draftGraph}
                    instances={instances}
                    readOnly={running}
                    onChangeNode={(patch) => updateNode(selectedNode.id, patch)}
                    onDeleteNode={removeNode}
                    onConnect={addConnection}
                    onDeleteConnection={removeConnection}
                  />
                )}
              </div>
            )}

            {tab === "runs" && (
              <WorkflowRunsPanel
                runs={runs}
                selectedRunId={selectedRunId}
                starting={startingRun}
                onSelectRun={setSelectedRunId}
                onStartRun={(trigger) => void handleStartRun(trigger)}
                onCancelRun={(runId) => void handleCancelRun(runId)}
                onRespondRun={(runId, input) => void handleRespondRun(runId, input)}
              />
            )}

            {tab === "document" && (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                <label className="flex flex-col gap-1 text-[12px]">
                  <span className="text-ink-secondary">Working folder (leave blank for isolated workflow workspace)</span>
                  <input
                    type="text"
                    disabled={running}
                    value={draftFolder}
                    onChange={(event) => {
                      setDraftFolder(event.target.value);
                      setDirty(true);
                    }}
                    placeholder="/path/to/workspace"
                    className="rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </label>
                <label className="flex min-h-0 flex-1 flex-col gap-1 text-[12px]">
                  <span className="text-ink-secondary">Responsible document (system prompt shared by all text steps)</span>
                  <textarea
                    disabled={running}
                    value={draftDocument}
                    onChange={(event) => {
                      setDraftDocument(event.target.value);
                      setDirty(true);
                    }}
                    className="min-h-[260px] flex-1 rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] text-ink outline-none focus:border-accent"
                  />
                </label>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
