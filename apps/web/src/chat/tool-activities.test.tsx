// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ToolActivity } from "@neoread/core";
import { ToolActivities } from "./ToolActivities";
it("keeps real execution states and saved web evidence accessible", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tool: ToolActivity = {
    id: "x",
    kind: "web",
    tool: "web_fetch",
    title: "读取网页",
    url: "https://example.com/docs",
    status: "running",
    startedAt: "2026-10-23T00:00:00Z",
  };
  try {
    await act(async () => root.render(<ToolActivities tools={[tool]} />));
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain("读取网页");
    await act(async () => button.click());
    expect(host.textContent).toContain("执行中");
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[{ ...tool, status: "completed" }]}
          sources={[
            {
              id: "W1",
              url: tool.url!,
              title: "Official docs",
              text: "Evidence snapshot",
              kind: "page",
              retrievedAt: "2026-10-23T00:00:00Z",
            },
          ]}
        />,
      ),
    );
    expect(host.textContent).toContain("已完成");
    expect(host.textContent).toContain("Evidence snapshot");
    expect(
      host.querySelectorAll('a[href="https://example.com/docs"]').length,
    ).toBe(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("preserves tool details across updates and parent folding, and distinguishes failure from cancellation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tool: ToolActivity = {
    id: "pdf",
    kind: "tool",
    tool: "read_passage",
    title: "查询 PDF 原文",
    target: "第 3 页 · S64",
    detail: "原文段落",
    status: "running",
    startedAt: "2026-10-23T00:00:00Z",
    url: "javascript:alert(1)",
  };
  try {
    await act(async () => root.render(<ToolActivities tools={[tool]} />));
    const summary = host.querySelector("button")!;
    await act(async () => summary.click());
    const detail = host.querySelectorAll("button")[1];
    await act(async () => detail.click());
    expect(host.textContent).toContain("原文段落");
    expect(host.querySelector("a")).toBeNull();
    await act(async () => summary.click());
    await act(async () => summary.click());
    expect(detail.getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[{ ...tool, status: "failed", detail: "查询失败" }]}
        />,
      ),
    );
    expect(detail.getAttribute("aria-expanded")).toBe("true");
    expect(detail.textContent).toContain("失败");
    expect(
      detail
        .querySelector('[data-slot="trace-line"]')
        ?.getAttribute("data-status"),
    ).toBe("error");
    await act(async () =>
      root.render(
        <ToolActivities tools={[{ ...tool, status: "cancelled" }]} />,
      ),
    );
    expect(detail.textContent).toContain("已取消");
    expect(
      host.querySelector('[data-status="running"], [data-status="error"]'),
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
