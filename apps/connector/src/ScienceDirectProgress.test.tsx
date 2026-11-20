// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ScienceDirectProgress } from "./ScienceDirectProgress";

it("keeps the large-paper choice after verification and displays completion for that import", async () => {
  const title = "Surface-anchored thin films";
  const initial = { status: "large-paper" as const, title };
  let imported = false;
  const sendMessage = vi.fn(async (message) => {
    if (message.type === "sciencedirect-resume") {
      imported = message.tabId === 23 && message.allowLarge === true && message.library === "books";
      return { ok: imported };
    }
    return { pending: imported ? { title, status: "done" } : initial };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<ScienceDirectProgress tabId={23} initial={initial} />));
    const books = Array.from(element.querySelectorAll("button")).find(b => b.textContent === "导入图书库");
    expect(books).toBeDefined();
    await act(async () => books!.click());
    expect(element.querySelector('[role="status"]')?.textContent).toContain("已收录");
    expect(element.querySelector("h1")?.textContent).toBe(title);
    expect(element.querySelectorAll("button")).toHaveLength(1);
    expect(element.querySelector("button")?.textContent).toBe("完成");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
