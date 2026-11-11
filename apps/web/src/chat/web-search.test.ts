import { expect, it } from "vitest";
import type { WebSearchConfig } from "@neoread/core";
import { webSearchEnabled } from "./web-search";

it("uses saved search permissions independently of the chat model connection", () => {
  const config: WebSearchConfig = {
    cliEnabled: false,
    provider: "deepseek",
    url: "https://search.example/v1",
    hasKey: true,
  };
  expect(webSearchEnabled("api", config)).toBe(true);
  expect(webSearchEnabled("codex", config)).toBe(false);
  expect(webSearchEnabled("codex", { ...config, cliEnabled: true })).toBe(true);
  expect(webSearchEnabled("api", { ...config, provider: "" })).toBe(false);
  expect(webSearchEnabled("api", { ...config, hasKey: false })).toBe(false);
  expect(
    webSearchEnabled("api", {
      ...config,
      provider: "keenable",
      url: "https://api.keenable.ai",
      hasKey: false,
    }),
  ).toBe(true);
  expect(webSearchEnabled("api")).toBe(false);
  expect(webSearchEnabled("codex")).toBe(false);
  for (const provider of ["claude", "kimi"])
    expect(webSearchEnabled(provider, { ...config, cliEnabled: true })).toBe(
      false,
    );
});
