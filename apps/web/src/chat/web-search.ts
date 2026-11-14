import type { WebSearchConfig } from "@neoread/core";

/** A request captures the saved permission; there is no per-composer toggle. */
export function webSearchEnabled(provider: string, config?: WebSearchConfig) {
  if (!config) return false;
  return (
    Boolean(provider) &&
    config.provider === "deepseek" &&
    !!config.url &&
    config.hasKey
  );
}
