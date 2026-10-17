// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, ReaderAdapter } from "@reader/core";
import { api } from "@reader/api";
import { SourceReferences } from "../SourceReferences";
import { MessageMarkdown } from "./MessageMarkdown";

vi.mock("@reader/api", () => ({ api: { validateEvidence: vi.fn() } }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.mocked(api.validateEvidence).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const location = {
  type: "epub" as const,
  href: "chapter.xhtml",
  locator: '{"locations":{"progression":0.3}}',
};
const message: Message = {
  id: "answer",
  documentId: "doc",
  role: "assistant",
  createdAt: "2026-10-17",
  content: "依据原文 citeS64",
  references: [
    { sourceId: "S64", text: "original excerpt", location, kind: "section" },
  ],
};
const navigate = vi.fn(async () => {});
const adapter = { flashReference: vi.fn() } as unknown as ReaderAdapter;
const render = (reader = adapter) =>
  act(async () =>
    root.render(
      <SourceReferences
        message={message}
        toc={[]}
        adapter={reader}
        onNavigate={navigate}
      >
        <MessageMarkdown content={message.content} />
      </SourceReferences>,
    ),
  );

it("validates the saved source before navigating to its native location", async () => {
  navigate.mockClear();
  let finish!: (value: { valid: boolean }) => void;
  vi.mocked(api.validateEvidence).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
  expect(api.validateEvidence).toHaveBeenCalledExactlyOnceWith(
    "doc",
    "answer",
    "S64",
  );
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => finish({ valid: true }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    location,
    "original excerpt",
  );
});

it("does not navigate when the source expired or its message unmounted", async () => {
  navigate.mockClear();
  vi.mocked(api.validateEvidence).mockRejectedValueOnce(
    new Error("原文版本已更新"),
  );
  await render();
  await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "原文版本已更新",
  );
  expect(navigate).not.toHaveBeenCalled();
  let finish!: (value: { valid: boolean }) => void;
  vi.mocked(api.validateEvidence).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
  await act(async () => root.render(null));
  await act(async () => finish({ valid: true }));
  expect(navigate).not.toHaveBeenCalled();
});

it("allows a fresh navigation after the reader changes during validation", async () => {
  navigate.mockClear();
  let finish!: (value: { valid: boolean }) => void;
  vi.mocked(api.validateEvidence).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
  await render({ ...adapter });
  vi.mocked(api.validateEvidence).mockResolvedValueOnce({ valid: true });
  await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
  expect(navigate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ valid: true }));
  expect(navigate).toHaveBeenCalledTimes(1);
});
