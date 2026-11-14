import { expect, it } from "vitest";
import type { WebSearchConfig } from "@neoread/core";
import { webSearchEnabled } from "./web-search";

it("uses saved search permissions independently of the chat model connection", () => {
  const config: WebSearchConfig = {
    provider: "deepseek",
    url: "https://search.example/v1",
    hasKey: true,
  };
  for (const provider of ["api", "codex", "claude", "kimi"]) {
    expect(webSearchEnabled(provider, config)).toBe(true);
    expect(webSearchEnabled(provider, { ...config, provider: "" })).toBe(false);
    expect(webSearchEnabled(provider, { ...config, hasKey: false })).toBe(
      false,
    );
    expect(webSearchEnabled(provider)).toBe(false);
  }
});
