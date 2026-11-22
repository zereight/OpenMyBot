import { useState } from "react";
import { Check, Play, Square, X } from "lucide-react";
import type { ApprovalOutput, WorkflowRespondInput, WorkflowRun } from "@/lib/workflows-api";
import { cn } from "@/lib/cn";

interface WorkflowRunsPanelProps {
  runs: WorkflowRun[];
  selectedRunId: string | null;
  starting: boolean;
  onSelectRun(runId: string): void;
  onStartRun(triggerText: string): void;
  onCancelRun(runId: string): void;
  onRespondRun(runId: string, input: WorkflowRespondInput): void;
}

function stateBadge(state: string): string {
  if (state === "done") return "bg-emerald-500/15 text-emerald-500";
  if (state === "running" || state === "queued") return "bg-accent/15 text-accent";
  if (state === "waiting") return "bg-amber-500/15 text-amber-500";
  if (state === "failed") return "bg-rose-500/15 text-rose-500";
  return "bg-ink/10 text-ink-secondary";
}

export function WorkflowRunsPanel({
  runs,
  selectedRunId,
  starting,
  onSelectRun,
  onStartRun,
  onCancelRun,
  onRespondRun,
}: WorkflowRunsPanelProps) {
  const [triggerText, setTriggerText] = useState("");
  const [approvalComment, setApprovalComment] = useState("");

  const activeRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const waitingNode =
    activeRun?.state === "waiting" && activeRun.waitingNodeId
      ? activeRun.graph.nodes.find((node) => node.id === activeRun.waitingNodeId) ?? null
      : null;
  const waitingNodeRun =
    activeRun?.state === "waiting" && activeRun.waitingNodeId ? activeRun.nodes[activeRun.waitingNodeId] ?? null : null;

  const submitApproval = (verdict: ApprovalOutput) => {
    if (!activeRun) return;
    onRespondRun(activeRun.id, { kind: "approval", verdict, comment: approvalComment });
    setApprovalComment("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hairline/40 px-4 py-3">
        <input
          type="text"
          value={triggerText}
          onChange={(event) => setTriggerText(event.target.value)}
          placeholder="Optional trigger input ({{trigger}})…"
          className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={starting}
          onClick={() => {
            onStartRun(triggerText);
            setTriggerText("");
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <Play size={13} />
          {starting ? "Starting…" : "Run workflow"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-60 shrink-0 overflow-y-auto border-r border-hairline/40 p-2">
          {runs.length === 0 ? (
            <p className="p-3 text-[12px] text-ink-secondary">No runs yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onSelectRun(run.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-left text-[12px] transition-colors",
                    activeRun?.id === run.id
                      ? "border-accent bg-accent/10 text-ink"
                      : "border-transparent hover:bg-raised text-ink-secondary",
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-mono text-[11px]">{run.id}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", stateBadge(run.state))}>
                      {run.state}
                    </span>
                  </div>
                  <span className="text-[11px] text-ink-secondary">
                    {new Date(run.startedAt).toLocaleTimeString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {!activeRun ? (
            <p className="text-[13px] text-ink-secondary">Start a run to inspect step outputs and approvals.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold text-ink">{activeRun.id}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", stateBadge(activeRun.state))}>
                    {activeRun.state}
                  </span>
                </div>
                {(activeRun.state === "running" || activeRun.state === "queued" || activeRun.state === "waiting") && (
                  <button
                    type="button"
                    onClick={() => onCancelRun(activeRun.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-2.5 py-1 text-[12px] text-rose-500 hover:bg-rose-500/10"
                  >
                    <Square size={11} />
                    Cancel run
                  </button>
                )}
              </div>

              {activeRun.error && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-500">
                  {activeRun.error}
                </div>
              )}

              {waitingNode && waitingNodeRun && (
                <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3.5">
                  <div className="text-[12px] font-semibold text-ink">
                    Action required: {waitingNode.name}
                  </div>
                  <p className="mt-1 text-[12px] text-ink-secondary">
                    {waitingNodeRun.waitReason || waitingNode.question}
                  </p>
                  {waitingNodeRun.input && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-app p-2.5 text-[11px] whitespace-pre-wrap text-ink">
                      {waitingNodeRun.input}
                    </pre>
                  )}
                  {waitingNode.kind === "approval" ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <textarea
                        rows={2}
                        value={approvalComment}
                        onChange={(event) => setApprovalComment(event.target.value)}
                        placeholder="Optional comment…"
                        className="rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => submitApproval("approve")}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500"
                        >
                          <Check size={13} />
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => submitApproval("reject")}
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-rose-500"
                        >
                          <X size={13} />
                          Reject
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {waitingNode.options.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => onRespondRun(activeRun.id, { kind: "decision", optionId: opt.id })}
                          className="rounded-lg border border-hairline/50 bg-app px-3 py-1.5 text-[12px] font-medium text-ink hover:border-accent hover:text-accent"
                        >
                          {opt.label || opt.id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                {activeRun.graph.nodes
                  .slice()
                  .sort((a, b) => a.number - b.number)
                  .map((node) => {
                    const nodeRun = activeRun.nodes[node.id];
                    if (!nodeRun) return null;
                    return (
                      <div key={node.id} className="rounded-xl border border-hairline/40 bg-inset/40 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[13px] font-medium text-ink">
                            #{node.number} {node.name}{" "}
                            <span className="text-[11px] font-normal text-ink-secondary">({node.kind})</span>
                          </div>
                          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", stateBadge(nodeRun.state))}>
                            {nodeRun.state}
                          </span>
                        </div>
                        {nodeRun.chosenOptionId && (
                          <div className="mt-1 text-[11px] text-ink-secondary">
                            Chosen option: <strong className="text-ink">{nodeRun.chosenOptionId}</strong>
                            {nodeRun.probabilities && (
                              <span className="ml-2">
                                ({Object.entries(nodeRun.probabilities)
                                  .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`)
                                  .join(", ")})
                              </span>
                            )}
                          </div>
                        )}
                        {nodeRun.verdict && (
                          <div className="mt-1 text-[11px] text-ink-secondary">
                            Verdict: <strong className="text-ink">{nodeRun.verdict}</strong>
                            {nodeRun.comment ? ` — ${nodeRun.comment}` : ""}
                          </div>
                        )}
                        {nodeRun.error && (
                          <div className="mt-1.5 text-[12px] text-rose-500">{nodeRun.error}</div>
                        )}
                        {nodeRun.output && (
                          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-app p-2.5 text-[12px] whitespace-pre-wrap text-ink">
                            {nodeRun.output}
                          </pre>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
