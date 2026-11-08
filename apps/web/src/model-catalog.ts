import { api } from "@neoread/api";
import type { AgentModel } from "@neoread/core";

type Listener = (provider: string, models: AgentModel[]) => void;
const listeners = new Set<Listener>();

// Share completed snapshots with mounted pickers without another HTTP request.
export function subscribeModelCatalog(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadModelCatalog(
  ...args: Parameters<typeof api.agentModels>
) {
  const models = await api.agentModels(...args);
  if (!args[1]?.aborted)
    listeners.forEach((listener) => listener(args[0], models));
  return models;
}
