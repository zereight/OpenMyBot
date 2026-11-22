import {
  APPROVAL_OUTPUTS,
  NODES_MAX,
  OPTION_ID_RE,
  OPTION_LABEL_MAX,
  OPTIONS_MAX,
  OPTIONS_MIN,
  QUESTION_MAX,
  type WorkflowCheckOutcome,
  type WorkflowCheckProblem,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from "./types.ts";

function connectionSourceKey(connection: WorkflowConnection): string {
  if (connection.source.kind === "option") return `option:${connection.source.optionId}`;
  if (connection.source.kind === "verdict") return `verdict:${connection.source.verdict}`;
  return "text";
}

function detectCycles(nodes: readonly WorkflowNode[], connections: readonly WorkflowConnection[]): string[] {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const conn of connections) {
    if (!inDegree.has(conn.from) || !inDegree.has(conn.to)) continue;
    outgoing.get(conn.from)!.push(conn.to);
    inDegree.set(conn.to, (inDegree.get(conn.to) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (visited === nodes.length) return [];
  return [...inDegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id);
}

export function checkWorkflowGraph(graph: WorkflowGraph): WorkflowCheckOutcome {
  const problems: WorkflowCheckProblem[] = [];

  if (graph.nodes.length > NODES_MAX) {
    problems.push({
      code: "too_many_nodes",
      message: `A workflow can have at most ${NODES_MAX} nodes.`,
      nodeIds: [],
    });
  }

  const nodeMap = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) {
      problems.push({
        code: "duplicate_node_id",
        message: `Duplicate node id "${node.id}".`,
        nodeIds: [node.id],
      });
      continue;
    }
    nodeMap.set(node.id, node);

    if (!node.name.trim()) {
      problems.push({
        code: "empty_node_name",
        message: `Node #${node.number} needs a name.`,
        nodeIds: [node.id],
      });
    }

    if (node.kind === "decision") {
      if (node.options.length < OPTIONS_MIN) {
        problems.push({
          code: "too_few_options",
          message: `Decision node "${node.name || node.id}" needs at least ${OPTIONS_MIN} options.`,
          nodeIds: [node.id],
        });
      }
      if (node.options.length > OPTIONS_MAX) {
        problems.push({
          code: "too_many_options",
          message: `Decision node "${node.name || node.id}" can have at most ${OPTIONS_MAX} options.`,
          nodeIds: [node.id],
        });
      }
      if (node.question.length > QUESTION_MAX) {
        problems.push({
          code: "question_too_long",
          message: `Decision question exceeds ${QUESTION_MAX} characters.`,
          nodeIds: [node.id],
        });
      }
      if (!Number.isFinite(node.threshold) || node.threshold < 0 || node.threshold > 1) {
        problems.push({
          code: "invalid_threshold",
          message: `Decision threshold must be between 0 and 1.`,
          nodeIds: [node.id],
        });
      }
      const seenOptions = new Set<string>();
      for (const option of node.options) {
        if (!OPTION_ID_RE.test(option.id)) {
          problems.push({
            code: "invalid_option_id",
            message: `Option id "${option.id}" must match ${OPTION_ID_RE.source}.`,
            nodeIds: [node.id],
          });
        }
        if (seenOptions.has(option.id)) {
          problems.push({
            code: "duplicate_option_id",
            message: `Duplicate option id "${option.id}".`,
            nodeIds: [node.id],
          });
        }
        seenOptions.add(option.id);
        if (option.label.length > OPTION_LABEL_MAX) {
          problems.push({
            code: "option_label_too_long",
            message: `Option label for "${option.id}" exceeds ${OPTION_LABEL_MAX} characters.`,
            nodeIds: [node.id],
          });
        }
      }
    } else if (node.kind === "approval") {
      if (node.question.length > QUESTION_MAX) {
        problems.push({
          code: "question_too_long",
          message: `Approval question exceeds ${QUESTION_MAX} characters.`,
          nodeIds: [node.id],
        });
      }
    }
  }

  const seenConnections = new Set<string>();
  for (const conn of graph.connections) {
    const fromNode = nodeMap.get(conn.from);
    const toNode = nodeMap.get(conn.to);
    if (!fromNode || !toNode) {
      problems.push({
        code: "missing_endpoint",
        message: `Connection "${conn.id}" points to a missing node.`,
        nodeIds: [conn.from, conn.to].filter((id) => nodeMap.has(id)),
      });
      continue;
    }
    if (conn.from === conn.to) {
      problems.push({
        code: "self_loop",
        message: `Node "${fromNode.name}" cannot connect to itself.`,
        nodeIds: [fromNode.id],
      });
      continue;
    }

    let validSource = false;
    if (fromNode.kind === "text") {
      validSource = conn.source.kind === "text";
    } else if (fromNode.kind === "decision") {
      if (conn.source.kind === "option") {
        const optionId = conn.source.optionId;
        validSource = fromNode.options.some((option) => option.id === optionId);
      }
    } else if (fromNode.kind === "approval") {
      validSource =
        conn.source.kind === "verdict" &&
        (APPROVAL_OUTPUTS as readonly string[]).includes(conn.source.verdict);
    }
    if (!validSource) {
      problems.push({
        code: "invalid_source",
        message: `Connection from "${fromNode.name}" has an invalid output port.`,
        nodeIds: [fromNode.id, toNode.id],
      });
      continue;
    }

    const dedupeKey = `${conn.from}|${connectionSourceKey(conn)}|${conn.to}`;
    if (seenConnections.has(dedupeKey)) {
      problems.push({
        code: "duplicate_connection",
        message: `Duplicate connection between "${fromNode.name}" and "${toNode.name}".`,
        nodeIds: [fromNode.id, toNode.id],
      });
      continue;
    }
    seenConnections.add(dedupeKey);
  }

  const cycleNodes = detectCycles(graph.nodes, graph.connections);
  if (cycleNodes.length > 0) {
    problems.push({
      code: "deadlock",
      message: "The workflow graph contains a cycle and cannot finish.",
      nodeIds: cycleNodes,
    });
  }

  return problems.length === 0 ? { state: "passed" } : { state: "problem", problems };
}
