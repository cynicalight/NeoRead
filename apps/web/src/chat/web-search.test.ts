import { expect, it } from "vitest";
import type { WebSearchConfig } from "@neoread/core";
import { webSearchEnabled } from "./web-search";

it("uses saved search permissions independently of the chat model connection", () => {
  const config: WebSearchConfig = {
    provider: "deepseek",
    url: "https://search.example/v1",
    hasKey: true,
  };
  const keenable: WebSearchConfig = {
    provider: "keenable",
    url: "https://api.keenable.ai",
    hasKey: false,
  };
  for (const provider of ["api", "codex", "claude", "kimi"]) {
    expect(webSearchEnabled(provider, config)).toBe(true);
    expect(webSearchEnabled(provider, { ...config, provider: "" })).toBe(false);
    expect(webSearchEnabled(provider, { ...config, hasKey: false })).toBe(
      false,
    );
    expect(webSearchEnabled(provider, keenable)).toBe(true);
    expect(webSearchEnabled(provider, { ...keenable, provider: "" })).toBe(
      false,
    );
    expect(webSearchEnabled(provider)).toBe(false);
  }
});
