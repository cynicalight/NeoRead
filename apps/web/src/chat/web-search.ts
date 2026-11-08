import type { WebSearchConfig } from "@neoread/core";

/** A request captures the saved permission; there is no per-composer toggle. */
export function webSearchEnabled(provider: string, config?: WebSearchConfig) {
  if (!config) return false;
  if (provider === "codex") return config.cliEnabled;
  if (provider !== "api" || !config.url) return false;
  // Keenable answers without a key; the optional key only lifts rate limits.
  if (config.provider === "keenable") return true;
  return config.provider === "deepseek" && config.hasKey;
}
