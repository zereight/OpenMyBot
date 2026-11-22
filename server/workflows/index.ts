import type { ProviderAdapter } from "../contracts.ts";
import type { Decider } from "../decider/index.ts";
import type { RouteHandler } from "../routes/table.ts";
import { createWorkflowRoutes } from "../routes/workflows.ts";
import { createWorkflowRunner, type WorkflowAdapterEntry } from "./runner.ts";
import { createWorkflowStore } from "./store.ts";

export interface WorkflowRegistryLike {
  get(instanceId: string): { instanceId: string; adapter: ProviderAdapter; defaultModel?: string } | null | undefined;
  instances(): Array<{ instanceId: string; adapter: ProviderAdapter; defaultModel?: string }>;
}

export function createWorkflowFeature(deps: {
  dataDir: string;
  registry: WorkflowRegistryLike;
  decider: Pick<Decider, "choose">;
}): RouteHandler {
  const store = createWorkflowStore(deps.dataDir);
  store.recoverInterruptedRuns();
  const runner = createWorkflowRunner({
    store,
    decider: deps.decider,
    getAdapter(instanceId): WorkflowAdapterEntry | null {
      const found = instanceId ? deps.registry.get(instanceId) : deps.registry.instances()[0];
      if (!found) return null;
      return { instanceId: found.instanceId, adapter: found.adapter, defaultModel: found.defaultModel };
    },
  });
  return createWorkflowRoutes({ store, runner });
}
