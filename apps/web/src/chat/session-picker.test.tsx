// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentChatSession } from "@neoread/core";
import { SessionPicker } from "./SessionPicker";

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("@neoread/api", () => ({
  api: { createChatSession: mocks.create, updateChatSession: mocks.update },
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("creates using the updated settings choice rather than the current session's previous backend", async () => {
  const current: DocumentChatSession = {
    id: "old-session",
    documentId: "doc",
    title: "方法问题",
    provider: "api",
    createdAt: "now",
    updatedAt: "now",
  };
  const onChange = vi.fn(),
    onRefresh = vi.fn().mockResolvedValue(undefined);
  const render = async (provider: string) => {
    await act(async () =>
      root.render(
        <SessionPicker
          documentId="doc"
          sessions={[current]}
          current={current}
          provider={provider}
          onChange={onChange}
          onRefresh={onRefresh}
        />,
      ),
    );
  };
  await render("api");
  await render("codex");
  mocks.create.mockResolvedValue({
    ...current,
    id: "new-session",
    provider: "codex",
  });
  await act(async () =>
    (
      host.querySelector('[aria-label="新建会话"]') as HTMLButtonElement
    ).click(),
  );
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith("doc", "codex");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("new-session");
  expect(mocks.update).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="会话后端"]')).toBeNull();
  expect(host.querySelector('[aria-label="选择会话"]')).not.toBeNull();
});

it.each([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const)(
  "does not show a separate status row for %s sessions",
  async (status) => {
    const current: DocumentChatSession = {
      id: "session",
      documentId: "doc",
      title: "方法问题",
      provider: "api",
      createdAt: "now",
      updatedAt: "now",
      latestRun: {
        id: "old-run",
        sessionId: "session",
        documentId: "doc",
        userMessageId: "question",
        provider: "api",
        status,
        startedAt: "now",
      },
    };
    await act(async () =>
      root.render(
        <SessionPicker
          documentId="doc"
          sessions={[current]}
          current={current}
          provider="api"
          onChange={() => {}}
          onRefresh={async () => {}}
        />,
      ),
    );
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[aria-label="选择会话"]')).not.toBeNull();
  },
);
