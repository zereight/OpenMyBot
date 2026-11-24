import { randomUUID } from "node:crypto";
import type { EffortLevel, ProviderAdapter, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import type { Decider } from "../decider/index.ts";
import { engineFailureKind } from "../drivers/engine-errors.ts";
import { classifyError } from "../drivers/retry.ts";
import { checkWorkflowGraph } from "./check.ts";
import type { WorkflowStore } from "./store.ts";
import {
  APPROVAL_COMMENT_MAX,
  WORKFLOW_DECISION_MAX_STATE_BYTES,
  WORKFLOW_DECISION_TIMEOUT_MS,
  WORKFLOW_DEFAULT_NODE_TIMEOUT_MS,
  WORKFLOW_MAX_CONCURRENT_TEXT_NODES,
  WORKFLOW_THREAD_PREFIX,
  type Workflow,
  type WorkflowConnection,
  type WorkflowModelTarget,
  type WorkflowNode,
  type WorkflowNodeRun,
  type WorkflowRespondInput,
  type WorkflowRun,
  type WorkflowSummary,
} from "./types.ts";

interface TextNodeTarget {
  instanceId: string | null;
  model: string | null;
  effort: string | null;
}

type TextAttemptResult =
  | { ok: true; output: string }
  | { ok: false; error: string; cancelled?: boolean; fallbackEligible: boolean };

type TextNodeResult =
  | { ok: true; output: string; usedInstanceId: string; usedModel?: string; fallbackAttempts: number }
  | { ok: false; error: string; cancelled?: boolean; fallbackAttempts: number };

function isFallbackEligibleFailure(input: {
  stopReason?: string | null;
  errorText: string;
  limit?: "engine" | "model" | "credits";
  trialCredit?: string;
}): boolean {
  if (input.stopReason === "auth_required") return true;
  if (input.limit !== undefined || input.trialCredit !== undefined) return true;
  const classified = classifyError({ text: input.errorText });
  if (classified.transient) {
    if (classified.reason === "rate_limited" || classified.reason === "overloaded" || classified.reason === "server_error") return true;
  } else if (classified.reason === "auth" || classified.reason === "quota" || classified.reason === "unknown_model") {
    return true;
  }
  const kind = engineFailureKind(input.errorText);
  return kind === "credits" || kind === "usage_limit" || kind === "rate_limit" || kind === "overloaded" || kind === "model_no_route";
}

function nodeTargets(node: WorkflowNode): TextNodeTarget[] {
  const primary: TextNodeTarget = { instanceId: node.instanceId, model: node.model, effort: node.effort };
  const fallbacks: WorkflowModelTarget[] = node.fallbacks ?? [];
  return [primary, ...fallbacks];
}

function targetLabel(target: TextNodeTarget, resolvedInstanceId?: string, resolvedModel?: string): string {
  const instance = resolvedInstanceId ?? target.instanceId ?? "default";
  const model = resolvedModel ?? target.model;
  return model ? `${instance}/${model}` : instance;
}

export interface WorkflowAdapterEntry {
  instanceId: string;
  adapter: ProviderAdapter;
  defaultModel?: string;
}

export interface WorkflowRunnerDeps {
  store: WorkflowStore;
  getAdapter(instanceId: string | null): WorkflowAdapterEntry | null;
  decider?: Pick<Decider, "choose">;
  nodeTimeoutMs?: number;
}

export interface WorkflowRunner {
  listSummaries(): WorkflowSummary[];
  isWorkflowRunning(workflowId: string): boolean;
  startRun(workflowId: string, triggerText?: string): { ok: true; run: WorkflowRun } | { ok: false; error: string; status: number };
  cancelRun(runId: string): Promise<{ ok: true; run: WorkflowRun } | { ok: false; error: string; status: number }>;
  respondToRun(runId: string, input: WorkflowRespondInput): { ok: true; run: WorkflowRun } | { ok: false; error: string; status: number };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

export function renderNodePrompt(prompt: string, input: string, triggerText: string): string {
  const hasInputToken = prompt.includes("{{input}}");
  let rendered = prompt.replaceAll("{{trigger}}", triggerText).replaceAll("{{input}}", input);
  if (!hasInputToken && input.trim().length > 0) {
    rendered = rendered.trim().length > 0 ? `${rendered}\n\n${input}` : input;
  }
  return rendered;
}

function isNodeEnded(nodeRun: WorkflowNodeRun): boolean {
  return nodeRun.state === "done" || nodeRun.state === "failed" || nodeRun.state === "skipped" || nodeRun.state === "cancelled";
}

function edgePassesOn(conn: WorkflowConnection, fromNode: WorkflowNode, fromRun: WorkflowNodeRun): boolean {
  if (fromNode.kind === "text") {
    return fromRun.state === "done" || (fromRun.state === "failed" && fromNode.continueOnFailure);
  }
  if (fromNode.kind === "decision") {
    return fromRun.state === "done" && conn.source.kind === "option" && fromRun.chosenOptionId === conn.source.optionId;
  }
  if (fromNode.kind === "approval") {
    return fromRun.state === "done" && conn.source.kind === "verdict" && fromRun.verdict === conn.source.verdict;
  }
  return false;
}

function findNextReadyNode(run: WorkflowRun): WorkflowNode | undefined {
  const incomingMap = new Map<string, WorkflowConnection[]>();
  for (const conn of run.graph.connections) {
    const list = incomingMap.get(conn.to) ?? [];
    list.push(conn);
    incomingMap.set(conn.to, list);
  }
  const ordered = [...run.graph.nodes].sort((a, b) => a.number - b.number);
  return ordered.find((node) => {
    const nodeRun = run.nodes[node.id];
    if (!nodeRun || nodeRun.state !== "pending") return false;
    const incoming = incomingMap.get(node.id) ?? [];
    return incoming.every((conn) => {
      const fromRun = run.nodes[conn.from];
      return fromRun !== undefined && isNodeEnded(fromRun);
    });
  });
}

function buildNodeInput(run: WorkflowRun, node: WorkflowNode): { shouldRun: boolean; input: string } {
  const incoming = run.graph.connections.filter((conn) => conn.to === node.id);
  if (incoming.length === 0) return { shouldRun: true, input: "" };

  const nodeById = new Map(run.graph.nodes.map((item) => [item.id, item]));
  const passing: Array<{ number: number; text: string }> = [];
  for (const conn of incoming) {
    const fromNode = nodeById.get(conn.from);
    const fromRun = run.nodes[conn.from];
    if (!fromNode || !fromRun) continue;
    if (!edgePassesOn(conn, fromNode, fromRun)) continue;
    const text =
      fromRun.output.trim().length > 0
        ? fromRun.output
        : fromRun.state === "failed" && fromRun.error
          ? `[Failed: ${fromRun.error}]`
          : "";
    passing.push({ number: fromNode.number, text });
  }
  if (passing.length === 0) return { shouldRun: false, input: "" };
  passing.sort((a, b) => a.number - b.number);
  return {
    shouldRun: true,
    input: passing.map((item) => item.text).filter((text) => text.length > 0).join("\n\n"),
  };
}

class SlotPool {
  private readonly free: string[];
  private readonly waiters: Array<(slot: string) => void> = [];

  constructor(size: number) {
    this.free = Array.from({ length: size }, (_, idx) => `${WORKFLOW_THREAD_PREFIX}${idx}`);
  }

  acquire(): Promise<string> {
    const slot = this.free.shift();
    if (slot) return Promise.resolve(slot);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(slot: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(slot);
      return;
    }
    this.free.push(slot);
  }
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  const slots = new SlotPool(WORKFLOW_MAX_CONCURRENT_TEXT_NODES);
  const nodeTimeoutMs = deps.nodeTimeoutMs ?? WORKFLOW_DEFAULT_NODE_TIMEOUT_MS;
  const activeRuns = new Map<
    string,
    {
      cancelled: boolean;
      interrupt?: () => Promise<void>;
    }
  >();

  async function executeTextNode(run: WorkflowRun, node: WorkflowNode, input: string): Promise<TextNodeResult> {
    let cwd: string;
    try {
      cwd = deps.store.ensureWorkspaceDir({
        id: run.workflowId,
        name: run.workflowName,
        document: run.document,
        folder: run.folder,
        permission: run.permission,
        graph: run.graph,
        createdAt: run.startedAt,
        updatedAt: run.startedAt,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), fallbackAttempts: 0 };
    }

    const slotThreadId = await slots.acquire();
    const control = activeRuns.get(run.id);
    if (!control || control.cancelled) {
      slots.release(slotThreadId);
      return { ok: false, error: "Run cancelled", cancelled: true, fallbackAttempts: 0 };
    }

    const approvalMode: SendTurnInput["approvalMode"] = node.permission ?? run.permission;
    const promptText = renderNodePrompt(node.prompt, input, run.triggerText);
    const targets = nodeTargets(node);
    const deadline = Date.now() + nodeTimeoutMs;
    const attemptErrors: string[] = [];

    try {
      for (const [index, target] of targets.entries()) {
        if (control.cancelled) {
          return { ok: false, error: "Run cancelled", cancelled: true, fallbackAttempts: index };
        }
        const entry = deps.getAdapter(target.instanceId);
        if (!entry) {
          const error = target.instanceId ? `Engine "${target.instanceId}" is not available.` : "No AI engine is configured.";
          attemptErrors.push(`${targetLabel(target)}: ${error}`);
          if (index + 1 < targets.length) continue;
          return {
            ok: false,
            error: targets.length === 1 ? error : `All model targets failed: ${attemptErrors.join("; ")}`,
            fallbackAttempts: index,
          };
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return {
            ok: false,
            error: `Node timed out after ${Math.round(nodeTimeoutMs / 1000)}s.`,
            fallbackAttempts: index,
          };
        }

        const model = target.model || entry.defaultModel;
        const effort = (target.effort || undefined) as EffortLevel | undefined;
        const attempt = await runSingleAttempt(entry, {
          slotThreadId,
          promptText,
          system: run.document || undefined,
          model,
          effort,
          approvalMode,
          cwd,
          remainingMs,
          nodeTimeoutMs,
          control,
        });

        if (attempt.ok) {
          return {
            ok: true,
            output: attempt.output,
            usedInstanceId: entry.instanceId,
            ...(model ? { usedModel: model } : {}),
            fallbackAttempts: index,
          };
        }
        if (attempt.cancelled || control.cancelled) {
          return { ok: false, error: attempt.error, cancelled: true, fallbackAttempts: index };
        }
        attemptErrors.push(`${targetLabel(target, entry.instanceId, model)}: ${attempt.error}`);
        if (!attempt.fallbackEligible || index + 1 >= targets.length) {
          return {
            ok: false,
            error: targets.length === 1 || !attempt.fallbackEligible ? attempt.error : `All model targets failed: ${attemptErrors.join("; ")}`,
            fallbackAttempts: index,
          };
        }
      }

      return {
        ok: false,
        error: `All model targets failed: ${attemptErrors.join("; ")}`,
        fallbackAttempts: Math.max(0, targets.length - 1),
      };
    } finally {
      slots.release(slotThreadId);
    }
  }

  function runSingleAttempt(
    entry: WorkflowAdapterEntry,
    params: {
      slotThreadId: string;
      promptText: string;
      system?: string;
      model?: string;
      effort?: EffortLevel;
      approvalMode: SendTurnInput["approvalMode"];
      cwd: string;
      remainingMs: number;
      nodeTimeoutMs: number;
      control: { cancelled: boolean; interrupt?: () => Promise<void> };
    },
  ): Promise<TextAttemptResult> {
    let turnId: string | undefined;
    let settled = false;
    const completedItems: string[] = [];
    let streamedText = "";
    let hasSideEffectOrOutput = false;
    let lastRuntimeError: { message: string; limit?: "engine" | "model" | "credits"; trialCredit?: string } | undefined;

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: TextAttemptResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        params.control.interrupt = undefined;
        resolve(result);
      };

      const unsubscribe = entry.adapter.onEvent((event: RuntimeEvent) => {
        if (event.threadId !== params.slotThreadId) return;
        if (turnId && event.turnId && event.turnId !== turnId) return;

        if (event.type === "content.delta" && event.streamKind === "assistant_text") {
          if (event.delta.length > 0) hasSideEffectOrOutput = true;
          streamedText += event.delta;
          return;
        }
        if (event.type === "item.completed" && event.itemType === "assistant_text") {
          if (event.text.length > 0) hasSideEffectOrOutput = true;
          completedItems.push(event.text);
          return;
        }
        if ((event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool") {
          hasSideEffectOrOutput = true;
          return;
        }
        if (event.type === "runtime.error") {
          lastRuntimeError = { message: event.message, limit: event.limit, trialCredit: event.trialCredit };
          return;
        }
        if (event.type === "request.opened" && event.requestId) {
          hasSideEffectOrOutput = true;
          const behavior = params.approvalMode === "full" && event.requestType === "permission" ? "allow" : "deny";
          void entry.adapter
            .respondToRequest(params.slotThreadId, event.requestId, {
              behavior,
              ...(behavior === "deny" ? { message: "Interactive prompts are disabled during workflow runs." } : {}),
            })
            .catch(() => {});
          return;
        }
        if (event.type === "turn.completed") {
          if (params.control.cancelled) {
            finish({ ok: false, error: "Run cancelled", cancelled: true, fallbackEligible: false });
            return;
          }
          const output = (completedItems.length > 0 ? completedItems.join("\n\n") : streamedText).trim();
          if (event.ok) {
            finish({ ok: true, output });
          } else {
            const errorText = lastRuntimeError?.message || event.stopReason || "Turn failed";
            finish({
              ok: false,
              error: errorText,
              fallbackEligible:
                !hasSideEffectOrOutput &&
                isFallbackEligibleFailure({
                  stopReason: event.stopReason,
                  errorText,
                  limit: lastRuntimeError?.limit,
                  trialCredit: lastRuntimeError?.trialCredit,
                }),
            });
          }
        }
      });

      params.control.interrupt = async () => {
        await entry.adapter.interruptTurn(params.slotThreadId, turnId).catch(() => {});
        finish({ ok: false, error: "Run cancelled", cancelled: true, fallbackEligible: false });
      };

      timer = setTimeout(() => {
        void entry.adapter
          .interruptTurn(params.slotThreadId, turnId)
          .catch(() => {})
          .finally(() => {
            finish({
              ok: false,
              error: `Node timed out after ${Math.round(params.nodeTimeoutMs / 1000)}s.`,
              fallbackEligible: false,
            });
          });
      }, params.remainingMs);

      void entry.adapter
        .sendTurn({
          threadId: params.slotThreadId,
          text: params.promptText,
          system: params.system,
          model: params.model,
          effort: params.effort,
          approvalMode: params.approvalMode,
          cwd: params.cwd,
          sessionReset: true,
        })
        .then((started) => {
          turnId = started.turnId;
          if (params.control.cancelled) {
            void entry.adapter.interruptTurn(params.slotThreadId, turnId).catch(() => {});
            finish({ ok: false, error: "Run cancelled", cancelled: true, fallbackEligible: false });
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          finish({
            ok: false,
            error: message,
            fallbackEligible: !hasSideEffectOrOutput && isFallbackEligibleFailure({ errorText: message }),
          });
        });
    });
  }

  async function executeDecisionNode(run: WorkflowRun, node: WorkflowNode, input: string): Promise<boolean> {
    const nodeRun = run.nodes[node.id]!;
    if (!deps.decider) {
      nodeRun.state = "waiting";
      nodeRun.waitReason = "Decision model is not configured. Pick an option to continue.";
      run.state = "waiting";
      run.waitingNodeId = node.id;
      deps.store.saveRun(run);
      return true;
    }

    const optionsRecord: Record<string, string> = {};
    for (const option of node.options) {
      optionsRecord[option.id] = option.label || option.id;
    }

    const statePayload = truncateUtf8(
      JSON.stringify({ input, trigger: run.triggerText }),
      WORKFLOW_DECISION_MAX_STATE_BYTES,
    );

    const decision = await deps.decider
      .choose(
        "botDecide",
        statePayload,
        { instructions: node.question || "Choose the best option.", options: optionsRecord },
        { timeoutMs: WORKFLOW_DECISION_TIMEOUT_MS },
      )
      .catch(() => ({ ok: false as const, reason: "unreachable" as const }));

    if (decision.ok) {
      const probs: Record<string, number> = {};
      for (const [key, value] of Object.entries(decision.answers.probabilities)) {
        if (typeof value === "number" && Number.isFinite(value)) probs[key] = value;
      }
      nodeRun.probabilities = probs;
      if (decision.answers.pTop >= node.threshold && optionsRecord[decision.answers.choice] !== undefined) {
        nodeRun.chosenOptionId = decision.answers.choice;
        nodeRun.output = input;
        nodeRun.state = "done";
        nodeRun.endedAt = Date.now();
        deps.store.saveRun(run);
        return false;
      }
      nodeRun.state = "waiting";
      nodeRun.waitReason = `Top confidence ${(decision.answers.pTop * 100).toFixed(0)}% is below threshold ${(node.threshold * 100).toFixed(0)}%. Pick an option.`;
      run.state = "waiting";
      run.waitingNodeId = node.id;
      deps.store.saveRun(run);
      return true;
    }

    nodeRun.state = "waiting";
    nodeRun.waitReason = `Decision model unavailable (${decision.reason}). Pick an option to continue.`;
    run.state = "waiting";
    run.waitingNodeId = node.id;
    deps.store.saveRun(run);
    return true;
  }

  async function driveRun(runId: string): Promise<void> {
    const control = { cancelled: false };
    activeRuns.set(runId, control);
    try {
      while (true) {
        const run = deps.store.getRun(runId);
        if (!run) return;
        if (control.cancelled || run.state === "cancelled") {
          run.state = "cancelled";
          run.endedAt = run.endedAt ?? Date.now();
          deps.store.saveRun(run);
          return;
        }
        if (run.state !== "running" && run.state !== "queued") return;

        if (run.state === "queued") {
          run.state = "running";
          deps.store.saveRun(run);
        }

        const nextNode = findNextReadyNode(run);
        if (!nextNode) {
          const anyPending = Object.values(run.nodes).some((item) => item.state === "pending");
          run.state = anyPending ? "failed" : "done";
          if (anyPending) run.error = "Workflow stalled with unfinished nodes.";
          run.endedAt = Date.now();
          deps.store.saveRun(run);
          return;
        }

        const nodeRun = run.nodes[nextNode.id]!;
        const { shouldRun, input } = buildNodeInput(run, nextNode);
        nodeRun.input = input;

        if (!shouldRun) {
          nodeRun.state = "skipped";
          nodeRun.endedAt = Date.now();
          deps.store.saveRun(run);
          continue;
        }

        nodeRun.state = "running";
        nodeRun.startedAt = Date.now();
        deps.store.saveRun(run);

        if (nextNode.kind === "approval") {
          nodeRun.state = "waiting";
          nodeRun.waitReason = nextNode.question || "Approval required to continue.";
          run.state = "waiting";
          run.waitingNodeId = nextNode.id;
          deps.store.saveRun(run);
          return;
        }

        if (nextNode.kind === "decision") {
          const waiting = await executeDecisionNode(run, nextNode, input);
          if (waiting) return;
          continue;
        }

        const result = await executeTextNode(run, nextNode, input);
        if (result.fallbackAttempts > 0) nodeRun.fallbackAttempts = result.fallbackAttempts;
        if (result.ok) {
          nodeRun.state = "done";
          nodeRun.output = result.output;
          nodeRun.usedInstanceId = result.usedInstanceId;
          if (result.usedModel) nodeRun.usedModel = result.usedModel;
          nodeRun.endedAt = Date.now();
          deps.store.saveRun(run);
        } else if (result.cancelled || control.cancelled) {
          nodeRun.state = "cancelled";
          nodeRun.error = result.error;
          nodeRun.endedAt = Date.now();
          run.state = "cancelled";
          run.endedAt = Date.now();
          deps.store.saveRun(run);
          return;
        } else {
          nodeRun.state = "failed";
          nodeRun.error = result.error;
          nodeRun.endedAt = Date.now();
          if (!nextNode.continueOnFailure) {
            run.state = "failed";
            run.error = `Node "${nextNode.name}" failed: ${result.error}`;
            run.endedAt = Date.now();
            deps.store.saveRun(run);
            return;
          }
          deps.store.saveRun(run);
        }
      }
    } finally {
      activeRuns.delete(runId);
    }
  }

  function isWorkflowRunning(workflowId: string): boolean {
    return deps.store
      .listRuns(workflowId)
      .some((run) => run.state === "queued" || run.state === "running" || run.state === "waiting");
  }

  return {
    listSummaries() {
      return deps.store.listWorkflows().map((workflow: Workflow): WorkflowSummary => {
        const runs = deps.store.listRuns(workflow.id);
        const last = runs[0] ?? null;
        const running = runs.some((run) => run.state === "queued" || run.state === "running" || run.state === "waiting");
        const working = runs.some((run) => run.state === "running");
        const check = checkWorkflowGraph(workflow.graph).state;
        return {
          id: workflow.id,
          name: workflow.name,
          folder: workflow.folder,
          permission: workflow.permission,
          nodeCount: workflow.graph.nodes.length,
          running,
          working,
          check,
          lastRun: last ? { id: last.id, state: last.state, startedAt: last.startedAt, endedAt: last.endedAt } : null,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
        };
      });
    },
    isWorkflowRunning,
    startRun(workflowId, triggerText = "") {
      const workflow = deps.store.getWorkflow(workflowId);
      if (!workflow) return { ok: false, error: "Workflow not found", status: 404 };
      const check = checkWorkflowGraph(workflow.graph);
      if (check.state === "problem") {
        return { ok: false, error: check.problems[0]?.message ?? "Workflow graph has errors.", status: 400 };
      }
      if (workflow.graph.nodes.length === 0) {
        return { ok: false, error: "Workflow has no nodes to run.", status: 400 };
      }

      const now = Date.now();
      const nodes: Record<string, WorkflowNodeRun> = {};
      for (const node of workflow.graph.nodes) {
        nodes[node.id] = {
          nodeId: node.id,
          nodeName: node.name,
          kind: node.kind,
          state: "pending",
          input: "",
          output: "",
          startedAt: null,
          endedAt: null,
        };
      }
      const run: WorkflowRun = {
        id: `wfrun-${randomUUID().slice(0, 12)}`,
        workflowId: workflow.id,
        workflowName: workflow.name,
        state: "queued",
        triggerText,
        graph: structuredClone(workflow.graph),
        document: workflow.document,
        folder: workflow.folder,
        permission: workflow.permission,
        nodes,
        waitingNodeId: null,
        startedAt: now,
        endedAt: null,
      };
      deps.store.saveRun(run);
      void driveRun(run.id);
      return { ok: true, run };
    },
    async cancelRun(runId) {
      const run = deps.store.getRun(runId);
      if (!run) return { ok: false, error: "Run not found", status: 404 };
      if (run.state === "done" || run.state === "failed" || run.state === "cancelled") {
        return { ok: true, run };
      }
      const control = activeRuns.get(runId);
      if (control) {
        control.cancelled = true;
        if (control.interrupt) await control.interrupt();
      }
      const latest = deps.store.getRun(runId) ?? run;
      latest.state = "cancelled";
      latest.waitingNodeId = null;
      latest.endedAt = latest.endedAt ?? Date.now();
      for (const nodeRun of Object.values(latest.nodes)) {
        if (nodeRun.state === "running" || nodeRun.state === "waiting") {
          nodeRun.state = "cancelled";
          nodeRun.endedAt = Date.now();
        }
      }
      deps.store.saveRun(latest);
      return { ok: true, run: latest };
    },
    respondToRun(runId, input) {
      const run = deps.store.getRun(runId);
      if (!run) return { ok: false, error: "Run not found", status: 404 };
      if (run.state !== "waiting" || !run.waitingNodeId) {
        return { ok: false, error: "Run is not waiting for a response.", status: 409 };
      }
      const node = run.graph.nodes.find((item) => item.id === run.waitingNodeId);
      const nodeRun = run.nodes[run.waitingNodeId];
      if (!node || !nodeRun || nodeRun.state !== "waiting") {
        return { ok: false, error: "Waiting node not found.", status: 409 };
      }

      if (input.kind === "approval") {
        if (node.kind !== "approval") return { ok: false, error: "Waiting node is not an approval node.", status: 400 };
        const comment = (input.comment ?? "").trim().slice(0, APPROVAL_COMMENT_MAX);
        nodeRun.verdict = input.verdict;
        nodeRun.comment = comment;
        nodeRun.output = comment
          ? `${nodeRun.input ? `${nodeRun.input}\n\n` : ""}Comment from the user:\n${comment}`
          : nodeRun.input;
        nodeRun.state = "done";
        nodeRun.endedAt = Date.now();
      } else {
        if (node.kind !== "decision") return { ok: false, error: "Waiting node is not a decision node.", status: 400 };
        if (!node.options.some((option) => option.id === input.optionId)) {
          return { ok: false, error: `Unknown option "${input.optionId}".`, status: 400 };
        }
        nodeRun.chosenOptionId = input.optionId;
        nodeRun.output = nodeRun.input;
        nodeRun.state = "done";
        nodeRun.endedAt = Date.now();
      }

      run.state = "running";
      run.waitingNodeId = null;
      deps.store.saveRun(run);
      void driveRun(run.id);
      return { ok: true, run };
    },
  };
}
