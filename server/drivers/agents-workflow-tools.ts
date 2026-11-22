import { WORKFLOW_PERMISSIONS } from "../workflows/types.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const WORKFLOW_INFO_PATH = "/api/internal/workflows/info";
export const WORKFLOW_EDIT_PATH = "/api/internal/workflows/edit";
export const WORKFLOW_DELETE_PATH = "/api/internal/workflows/delete";
const PATHS: Record<string, string> = { workflow_info: WORKFLOW_INFO_PATH, workflow: WORKFLOW_EDIT_PATH, delete_workflow: WORKFLOW_DELETE_PATH };
export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(PATHS));

export async function callWorkflowTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(PATHS[name]!, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The workflow change did not go through. Try again shortly."), isError: true };
}

export const WORKFLOW_TOOL_DEFINITIONS = [
  {
    name: "workflow_info",
    description: "The person's workflows (Workflows in the sidebar). No ids: the list. workflow_id: its settings, graph, problems and runs. run_id: each step's state and output.",
    inputSchema: { type: "object", additionalProperties: false, properties: { workflow_id: { type: "string" }, run_id: { type: "string" } } },
  },
  {
    name: "workflow",
    description:
      "Create, update, run or cancel a workflow the person asked for. graph is {nodes:[{id,kind,name,prompt,question,options:[{id,label}],threshold,instance_id,model,effort,permission,continue_on_failure}],connections:[{from,to,when}]}, the shape workflow_info shows; it replaces the whole graph, so read with workflow_info first before updating and include all steps and connections to keep (kept ids keep their place). kind text is an AI turn: prompt, where {{trigger}} is the run's input and {{input}} the steps before; decision picks an option (when: its id); approval waits for the person (when: approve or reject). Steps never run above your own permission.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "update", "run", "cancel"] },
        workflow_id: { type: "string" },
        run_id: { type: "string", description: "cancel." },
        name: { type: "string" },
        document: { type: "string", description: "Instructions every step gets." },
        folder: { type: "string", description: "Absolute folder the steps work in; \"\" = its own." },
        permission: { type: "string", enum: [...WORKFLOW_PERMISSIONS] },
        graph: { type: "object", additionalProperties: true },
        input: { type: "string", description: "run: the {{trigger}}." },
      },
      required: ["action"],
    },
  },
  {
    name: "delete_workflow",
    description: "Remove a workflow and its run history, only when the person asks.",
    inputSchema: { type: "object", additionalProperties: false, properties: { workflow_id: { type: "string", minLength: 1 } }, required: ["workflow_id"] },
  },
];
