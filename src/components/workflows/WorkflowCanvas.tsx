import { useRef, useState } from "react";
import { CheckCircle2, GitBranch, MessageSquare, ShieldCheck, X } from "lucide-react";
import type {
  WorkflowConnection,
  WorkflowConnectionSource,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeRun,
} from "@/lib/workflows-api";
import { cn } from "@/lib/cn";

const NODE_W = 220;
const NODE_H = 88;

interface PendingLink {
  fromId: string;
  source: WorkflowConnectionSource;
  label: string;
}

interface WorkflowCanvasProps {
  graph: WorkflowGraph;
  selectedNodeId: string | null;
  problemNodeIds: ReadonlySet<string>;
  nodeRuns?: Record<string, WorkflowNodeRun>;
  readOnly: boolean;
  onSelectNode(nodeId: string | null): void;
  onMoveNode(nodeId: string, x: number, y: number): void;
  onConnect(fromId: string, toId: string, source: WorkflowConnectionSource): void;
  onDeleteConnection(connectionId: string): void;
}

function edgeLabel(conn: WorkflowConnection, fromNode: WorkflowNode): string {
  if (conn.source.kind === "verdict") return conn.source.verdict === "approve" ? "Approve" : "Reject";
  if (conn.source.kind === "option") {
    const optionId = conn.source.optionId;
    const opt = fromNode.options.find((item) => item.id === optionId);
    return opt?.label || optionId;
  }
  return "";
}

function runBadgeClass(state?: WorkflowNodeRun["state"]): string {
  if (state === "done") return "bg-emerald-500/15 text-emerald-500";
  if (state === "running") return "bg-accent/15 text-accent";
  if (state === "waiting") return "bg-amber-500/15 text-amber-500";
  if (state === "failed") return "bg-rose-500/15 text-rose-500";
  if (state === "skipped" || state === "cancelled") return "bg-ink/10 text-ink-secondary";
  return "bg-ink/[0.06] text-ink-secondary";
}

function kindIcon(kind: WorkflowNode["kind"]) {
  if (kind === "decision") return <GitBranch size={13} className="text-amber-500" />;
  if (kind === "approval") return <ShieldCheck size={13} className="text-emerald-500" />;
  return <MessageSquare size={13} className="text-accent" />;
}

export function WorkflowCanvas({
  graph,
  selectedNodeId,
  problemNodeIds,
  nodeRuns,
  readOnly,
  onSelectNode,
  onMoveNode,
  onConnect,
  onDeleteConnection,
}: WorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const canvasWidth = Math.max(920, ...graph.nodes.map((node) => node.x + NODE_W + 140));
  const canvasHeight = Math.max(520, ...graph.nodes.map((node) => node.y + NODE_H + 140));

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || readOnly || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + containerRef.current.scrollLeft - drag.offsetX;
    const rawY = event.clientY - rect.top + containerRef.current.scrollTop - drag.offsetY;
    const x = Math.max(20, Math.round(rawX / 16) * 16);
    const y = Math.max(20, Math.round(rawY / 16) * 16);
    onMoveNode(drag.nodeId, x, y);
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-inset/50">
      {pendingLink && (
        <div className="flex items-center justify-between border-b border-hairline/40 bg-accent/10 px-3 py-1.5 text-[12px] text-ink">
          <span>
            Connecting from <strong>{nodeById.get(pendingLink.fromId)?.name}</strong> ({pendingLink.label}) — click a target node.
          </span>
          <button
            type="button"
            onClick={() => setPendingLink(null)}
            className="rounded px-2 py-0.5 text-[11px] font-medium hover:bg-ink/10"
          >
            Cancel
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onClick={() => {
          if (!pendingLink) onSelectNode(null);
        }}
        className="relative min-h-0 flex-1 overflow-auto"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-ink) 12%, transparent) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        <div className="relative" style={{ width: canvasWidth, height: canvasHeight }}>
          <svg
            width={canvasWidth}
            height={canvasHeight}
            className="pointer-events-none absolute inset-0"
          >
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" className="text-ink-secondary" />
              </marker>
            </defs>
            {graph.connections.map((conn) => {
              const from = nodeById.get(conn.from);
              const to = nodeById.get(conn.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
              const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
              return (
                <path
                  key={conn.id}
                  d={pathD}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  markerEnd="url(#wf-arrow)"
                  className="text-ink-secondary/60"
                />
              );
            })}
          </svg>

          {graph.connections.map((conn) => {
            const from = nodeById.get(conn.from);
            const to = nodeById.get(conn.to);
            if (!from || !to) return null;
            const midX = (from.x + NODE_W + to.x) / 2;
            const midY = (from.y + to.y + NODE_H) / 2;
            const label = edgeLabel(conn, from);
            return (
              <div
                key={`${conn.id}-label`}
                style={{ left: midX, top: midY }}
                className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 rounded-full border border-hairline/50 bg-app px-2 py-0.5 text-[11px] text-ink-secondary shadow-sm"
              >
                <span>{label || "→"}</span>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove connection"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteConnection(conn.id);
                    }}
                    className="rounded-full p-0.5 hover:bg-rose-500/15 hover:text-rose-500"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            );
          })}

          {graph.nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            const hasProblem = problemNodeIds.has(node.id);
            const nodeRun = nodeRuns?.[node.id];
            const ports: Array<{ label: string; source: WorkflowConnectionSource }> =
              node.kind === "text"
                ? [{ label: "Next", source: { kind: "text" } }]
                : node.kind === "approval"
                  ? [
                      { label: "Approve", source: { kind: "verdict", verdict: "approve" } },
                      { label: "Reject", source: { kind: "verdict", verdict: "reject" } },
                    ]
                  : node.options.map((opt) => ({
                      label: opt.label || opt.id,
                      source: { kind: "option", optionId: opt.id },
                    }));

            return (
              <div
                key={node.id}
                data-workflow-node={node.id}
                style={{ left: node.x, top: node.y, width: NODE_W }}
                onPointerDown={(event) => {
                  if (readOnly || (event.target as HTMLElement).closest("button")) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  dragRef.current = {
                    nodeId: node.id,
                    offsetX: event.clientX - rect.left,
                    offsetY: event.clientY - rect.top,
                  };
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (pendingLink) {
                    if (pendingLink.fromId !== node.id) {
                      onConnect(pendingLink.fromId, node.id, pendingLink.source);
                    }
                    setPendingLink(null);
                    return;
                  }
                  onSelectNode(node.id);
                }}
                className={cn(
                  "absolute select-none rounded-xl border bg-app p-2.5 shadow-sm transition-colors",
                  readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
                  selected ? "border-accent ring-2 ring-accent/25" : "border-hairline/50 hover:border-hairline",
                  hasProblem && "border-rose-500 ring-2 ring-rose-500/25",
                  pendingLink && pendingLink.fromId !== node.id && "hover:border-accent hover:ring-2 hover:ring-accent/30",
                )}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {kindIcon(node.kind)}
                    <span className="text-[11px] font-mono text-ink-secondary">#{node.number}</span>
                    <span className="truncate text-[13px] font-medium text-ink">{node.name}</span>
                  </div>
                  {nodeRun && (
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", runBadgeClass(nodeRun.state))}>
                      {nodeRun.state}
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-ink-secondary">
                  {node.kind === "text"
                    ? node.prompt || "Empty prompt"
                    : node.question || "No question set"}
                </p>
                {!readOnly && (
                  <div className="mt-2 flex flex-wrap gap-1 border-t border-hairline/30 pt-1.5">
                    {ports.map((port, idx) => (
                      <button
                        key={`${node.id}-port-${idx}`}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPendingLink({ fromId: node.id, source: port.source, label: port.label });
                        }}
                        className="inline-flex items-center gap-1 rounded bg-control px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary hover:bg-accent/15 hover:text-accent"
                      >
                        <CheckCircle2 size={9} />
                        {port.label} →
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
