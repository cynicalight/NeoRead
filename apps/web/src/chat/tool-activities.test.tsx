// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ToolActivity } from "@neoread/core";
import { ToolActivities } from "./ToolActivities";

it("shows the same concise document reading record for API and Codex", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tool: ToolActivity = {
    id: "read",
    kind: "tool",
    tool: "read_passage",
    title: "读取文档",
    target: "正在阅读第 2—2 页 · 阅读连续原文",
    status: "completed",
    startedAt: "2026-10-23T00:00:00Z",
    finishedAt: "2026-10-23T00:00:00Z",
  };
  try {
    await act(async () => root.render(<ToolActivities tools={[tool]} />));
    await act(async () => host.querySelector("button")!.click());
    for (const version of [
      tool,
      { ...tool, target: "正在阅读第2-2页 · 阅读连续原文" },
      { ...tool, target: "正在阅读第 2 – 2 页 · 阅读连续原文" },
      { ...tool, tool: "neoread_document/read_passage", title: "调用工具" },
    ]) {
      await act(async () => root.render(<ToolActivities tools={[version]} />));
      expect(host.textContent).toContain("读取文档 · 正在阅读第 2 页");
      expect(host.textContent).not.toMatch(
        /read_passage|阅读连续原文|调用工具/,
      );
      expect(host.querySelectorAll("button")).toHaveLength(1);
    }
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[{ ...tool, target: "正在阅读第 2—4 页 · 阅读连续原文" }]}
        />,
      ),
    );
    expect(host.textContent).toContain("读取文档 · 正在阅读第 2—4 页");
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[
            { ...tool, status: "failed", detail: "文档工具暂未取得结果" },
          ]}
        />,
      ),
    );
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).toContain("文档工具暂未取得结果");
    expect(host.textContent).not.toContain("read_passage");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
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
    expect(button.textContent).toContain("执行记录");
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
    expect(host.textContent).not.toContain("已完成");
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
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).toContain("原文段落");
    expect(host.querySelector("a")).toBeNull();
    await act(async () => summary.click());
    await act(async () => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[{ ...tool, status: "failed", detail: "查询失败" }]}
        />,
      ),
    );
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("svg.lucide-circle-x")).not.toBeNull();
    expect(
      host.querySelector('[data-status="error"]')?.getAttribute("data-status"),
    ).toBe("error");
    await act(async () =>
      root.render(
        <ToolActivities tools={[{ ...tool, status: "cancelled" }]} />,
      ),
    );
    expect(host.textContent).toContain("已取消");
    expect(
      host.querySelector('[data-status="running"], [data-status="error"]'),
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("shows an unavailable fetch as a neutral result while preserving service failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tool: ToolActivity = {
    id: "missing",
    kind: "web",
    tool: "web_fetch",
    title: "读取网页",
    url: "https://example.com/missing",
    status: "unavailable",
    detail: "未能取得此网址的网页内容，请尝试其他网址。",
    startedAt: "2026-11-02T00:00:00Z",
    finishedAt: "2026-11-02T00:00:01Z",
  };
  try {
    await act(async () => root.render(<ToolActivities tools={[tool]} />));
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("此网址无法读取");
    expect(host.textContent).not.toContain("有失败");
    expect(host.textContent).not.toContain("已完成");
    expect(host.querySelector('[data-status="error"]')).toBeNull();
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[
            { ...tool, status: "failed", detail: "网页读取服务暂不可用" },
          ]}
        />,
      ),
    );
    expect(host.textContent).toContain("有失败");
    expect(host.querySelector('[data-status="error"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps exhausted temporary web failures neutral without exposing HTTP errors", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ToolActivities
          tools={[
            {
              id: "temporary",
              kind: "web",
              tool: "web_fetch",
              title: "读取网页",
              status: "deferred",
              detail: "暂未取得结果",
              startedAt: "2026-11-02T00:00:00Z",
            },
          ]}
        />,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("暂未取得结果");
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).not.toMatch(/有失败|503|服务暂不可用|已完成/);
    expect(host.querySelector('[data-status="error"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
