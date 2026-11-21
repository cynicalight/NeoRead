// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { PaperTitleTranslationSettings } from "./PaperTitleTranslationSettings";

vi.mock("@neoread/api", () => ({
  api: { backfillPaperTitles: vi.fn() },
}));

it("reports saved and failed titles after manual backfill", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.mocked(api.backfillPaperTitles).mockResolvedValue({ translated: 2, failed: 1 });
  try {
    await act(async () => root.render(<PaperTitleTranslationSettings />));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "已补译 2 篇，1 篇失败，可重试。",
    );
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
