import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Select } from "@/components/Select";
import type {
  WorkflowConnection,
  WorkflowConnectionSource,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowPermission,
} from "@/lib/workflows-api";

interface WorkflowNodeInspectorProps {
  node: WorkflowNode;
  graph: WorkflowGraph;
  instances: Array<{ instanceId: string; label: string }>;
  readOnly: boolean;
  onChangeNode(patch: Partial<WorkflowNode>): void;
  onDeleteNode(nodeId: string): void;
  onConnect(fromId: string, toId: string, source: WorkflowConnectionSource): void;
  onDeleteConnection(connectionId: string): void;
}

export function WorkflowNodeInspector({
  node,
  graph,
  instances,
  readOnly,
  onChangeNode,
  onDeleteNode,
  onConnect,
  onDeleteConnection,
}: WorkflowNodeInspectorProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [sourceKey, setSourceKey] = useState("text");

  const otherNodes = graph.nodes.filter((item) => item.id !== node.id);
  const outgoing = graph.connections.filter((conn) => conn.from === node.id);

  const handleKindChange = (kind: WorkflowNodeKind) => {
    if (kind === "decision") {
      onChangeNode({
        kind,
        options:
          node.options.length >= 2
            ? node.options
            : [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
      });
      return;
    }
    onChangeNode({ kind, options: [] });
  };

  const addConnection = () => {
    if (!targetNodeId) return;
    let source: WorkflowConnectionSource;
    if (node.kind === "text") {
      source = { kind: "text" };
    } else if (node.kind === "approval") {
      source = { kind: "verdict", verdict: sourceKey === "reject" ? "reject" : "approve" };
    } else {
      const optId = node.options.some((opt) => opt.id === sourceKey) ? sourceKey : node.options[0]?.id;
      if (!optId) return;
      source = { kind: "option", optionId: optId };
    }
    onConnect(node.id, targetNodeId, source);
    setTargetNodeId("");
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-hairline/40 bg-app p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Node #{node.number}</h3>
        {!readOnly && (
          confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onDeleteNode(node.id)}
                className="rounded bg-rose-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-rose-500"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded bg-control px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-rose-500 hover:bg-rose-500/10"
            >
              <Trash2 size={12} />
              Delete
            </button>
          )
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3 text-[12px]">
        <label className="flex flex-col gap-1">
          <span className="text-ink-secondary">Name</span>
          <input
            type="text"
            disabled={readOnly}
            value={node.name}
            onChange={(event) => onChangeNode({ name: event.target.value })}
            className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-ink-secondary">Kind</span>
          <Select
            size="sm"
            disabled={readOnly}
            value={node.kind}
            onChange={(event) => handleKindChange(event.target.value as WorkflowNodeKind)}
          >
            <option value="text">Text (AI step)</option>
            <option value="decision">Decision (Branch)</option>
            <option value="approval">Approval (Human gate)</option>
          </Select>
        </label>

        {node.kind === "text" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">Prompt</span>
              <textarea
                rows={5}
                disabled={readOnly}
                value={node.prompt}
                onChange={(event) => onChangeNode({ prompt: event.target.value })}
                placeholder="Use {{input}} and {{trigger}}"
                className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              />
              <span className="text-[11px] text-ink-secondary">
                Supports <code>{"{{input}}"}</code> and <code>{"{{trigger}}"}</code>.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">Engine</span>
              <Select
                size="sm"
                disabled={readOnly}
                value={node.instanceId ?? ""}
                onChange={(event) => onChangeNode({ instanceId: event.target.value || null })}
              >
                <option value="">Default engine</option>
                {instances.map((item) => (
                  <option key={item.instanceId} value={item.instanceId}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">Model override</span>
              <input
                type="text"
                disabled={readOnly}
                value={node.model ?? ""}
                onChange={(event) => onChangeNode({ model: event.target.value.trim() || null })}
                placeholder="Leave blank for engine default"
                className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">Permission override</span>
              <Select
                size="sm"
                disabled={readOnly}
                value={node.permission ?? ""}
                onChange={(event) =>
                  onChangeNode({ permission: (event.target.value || null) as WorkflowPermission | null })
                }
              >
                <option value="">Follow workflow</option>
                <option value="full">Full access</option>
                <option value="edits">Edits only</option>
                <option value="ask">Ask</option>
              </Select>
            </label>

            <label className="flex items-center gap-2 text-[12px] text-ink">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={node.continueOnFailure}
                onChange={(event) => onChangeNode({ continueOnFailure: event.target.checked })}
              />
              Continue workflow if this step fails
            </label>
          </>
        )}

        {node.kind === "decision" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">Decision question</span>
              <textarea
                rows={3}
                disabled={readOnly}
                value={node.question}
                onChange={(event) => onChangeNode({ question: event.target.value })}
                placeholder="Which route should this follow?"
                className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-secondary">Auto-route threshold (0 – 1)</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                disabled={readOnly}
                value={node.threshold}
                onChange={(event) => onChangeNode({ threshold: Number(event.target.value) })}
                className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-ink-secondary">Options</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() =>
                      onChangeNode({
                        options: [
                          ...node.options,
                          { id: `opt_${node.options.length + 1}`, label: `Option ${node.options.length + 1}` },
                        ],
                      })
                    }
                    className="inline-flex items-center gap-1 rounded bg-control px-2 py-0.5 text-[11px] text-ink hover:bg-raised"
                  >
                    <Plus size={11} />
                    Add
                  </button>
                )}
              </div>
              {node.options.map((opt, idx) => (
                <div key={`${opt.id}-${idx}`} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    disabled={readOnly}
                    value={opt.id}
                    onChange={(event) => {
                      const next = node.options.map((item, i) => (i === idx ? { ...item, id: event.target.value } : item));
                      onChangeNode({ options: next });
                    }}
                    placeholder="id"
                    className="w-24 rounded border border-hairline/40 bg-inset px-2 py-1 font-mono text-[11px] text-ink"
                  />
                  <input
                    type="text"
                    disabled={readOnly}
                    value={opt.label}
                    onChange={(event) => {
                      const next = node.options.map((item, i) => (i === idx ? { ...item, label: event.target.value } : item));
                      onChangeNode({ options: next });
                    }}
                    placeholder="Label"
                    className="min-w-0 flex-1 rounded border border-hairline/40 bg-inset px-2 py-1 text-[11px] text-ink"
                  />
                  {!readOnly && node.options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => onChangeNode({ options: node.options.filter((_, i) => i !== idx) })}
                      className="rounded p-1 text-rose-500 hover:bg-rose-500/10"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {node.kind === "approval" && (
          <label className="flex flex-col gap-1">
            <span className="text-ink-secondary">Approval question</span>
            <textarea
              rows={3}
              disabled={readOnly}
              value={node.question}
              onChange={(event) => onChangeNode({ question: event.target.value })}
              placeholder="Approve this output before continuing?"
              className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
        )}

        <div className="mt-1 border-t border-hairline/40 pt-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
            Outgoing connections
          </div>
          {outgoing.length === 0 ? (
            <p className="text-[11px] text-ink-secondary">No outgoing connections.</p>
          ) : (
            <ul className="mb-2 flex flex-col gap-1">
              {outgoing.map((conn: WorkflowConnection) => {
                const target = graph.nodes.find((item) => item.id === conn.to);
                const port =
                  conn.source.kind === "option"
                    ? conn.source.optionId
                    : conn.source.kind === "verdict"
                      ? conn.source.verdict
                      : "next";
                return (
                  <li
                    key={conn.id}
                    className="flex items-center justify-between rounded bg-control/60 px-2 py-1 text-[11px]"
                  >
                    <span className="truncate">
                      <span className="font-mono text-ink-secondary">{port}</span> → {target?.name ?? conn.to}
                    </span>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => onDeleteConnection(conn.id)}
                        className="text-rose-500 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!readOnly && otherNodes.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {node.kind === "approval" && (
                <Select size="sm" value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
                  <option value="approve">On Approve</option>
                  <option value="reject">On Reject</option>
                </Select>
              )}
              {node.kind === "decision" && (
                <Select size="sm" value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
                  {node.options.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      Option: {opt.label || opt.id}
                    </option>
                  ))}
                </Select>
              )}
              <div className="flex items-center gap-1.5">
                <Select
                  size="sm"
                  className="flex-1"
                  value={targetNodeId}
                  onChange={(event) => setTargetNodeId(event.target.value)}
                >
                  <option value="">Connect to node…</option>
                  {otherNodes.map((item) => (
                    <option key={item.id} value={item.id}>
                      #{item.number} {item.name}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  disabled={!targetNodeId}
                  onClick={addConnection}
                  className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40"
                >
                  Link
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
