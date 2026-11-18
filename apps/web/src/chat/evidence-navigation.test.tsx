// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, ReaderAdapter } from "@neoread/core";
import { api } from "@neoread/api";
import { SourceReferences } from "../SourceReferences";
import { MessageMarkdown } from "./MessageMarkdown";

vi.mock("@neoread/api", () => ({ api: { validateEvidence: vi.fn() } }));
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
  progression: 0.3,
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
const render = (reader = adapter, saved = message) =>
  act(async () =>
    root.render(
      <SourceReferences
        message={saved}
        toc={[]}
        adapter={reader}
        onNavigate={navigate}
      >
        <MessageMarkdown content={saved.content} />
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
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button.chat-source-jump")!.click(),
  );
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
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button.chat-source-jump")!.click(),
  );
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
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button.chat-source-jump")!.click(),
  );
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
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button.chat-source-jump")!.click(),
  );
  await render({ ...adapter });
  vi.mocked(api.validateEvidence).mockResolvedValueOnce({ valid: true });
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button.chat-source-jump")!.click(),
  );
  expect(navigate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ valid: true }));
  expect(navigate).toHaveBeenCalledTimes(1);
});

const block = "c41151675761-182";
const blockLocation = { type: "pdf" as const, page: 4 };
const direct: Message = {
  ...message,
  content: `依据原文 [${block}]，另见 [c41151675761-999]。`,
  references: [
    {
      blockId: block,
      text: "searched excerpt",
      location: blockLocation,
      precision: "block",
    },
  ],
};

it("navigates a direct blockId citation through the saved search reference", async () => {
  navigate.mockClear();
  vi.mocked(adapter.flashReference!).mockClear();
  vi.mocked(api.validateEvidence).mockResolvedValueOnce({ valid: true });
  await render(adapter, direct);
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    "button.chat-source-jump",
  );
  expect(buttons).toHaveLength(1);
  expect(buttons[0].getAttribute("aria-label")).toBe(
    `跳转到原文段落 ${block}`,
  );
  // A block the server never returned stays readable and inert.
  expect(host.textContent).toContain("另见 [c41151675761-999]。");
  await act(async () => buttons[0].click());
  expect(api.validateEvidence).toHaveBeenCalledExactlyOnceWith(
    "doc",
    "answer",
    block,
  );
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    blockLocation,
    "searched excerpt",
  );
  expect(adapter.flashReference).toHaveBeenCalledExactlyOnceWith(
    blockLocation,
    "searched excerpt",
  );
});

it("links an S label explicitly mapped to a block without linking the bare blockId", async () => {
  navigate.mockClear();
  vi.mocked(api.validateEvidence).mockResolvedValueOnce({ valid: true });
  await render(adapter, {
    ...direct,
    content: `结论 [S1] ${block}`,
    references: [{ ...direct.references![0], sourceId: "S1" }],
  });
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    "button.chat-source-jump",
  );
  expect(buttons).toHaveLength(1);
  expect(buttons[0].getAttribute("aria-label")).toBe("跳转到原文段落 S1");
  expect(host.textContent).toContain(`结论  ${block}`);
  await act(async () => buttons[0].click());
  expect(api.validateEvidence).toHaveBeenCalledExactlyOnceWith(
    "doc",
    "answer",
    "S1",
  );
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    blockLocation,
    "searched excerpt",
  );
});

it("groups adjacent S and block citations and navigates the chosen block", async () => {
  navigate.mockClear();
  vi.mocked(api.validateEvidence).mockResolvedValueOnce({ valid: true });
  await render(adapter, {
    ...direct,
    content: `依据原文 [S64][${block}]。`,
    references: [message.references![0], direct.references![0]],
  });
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    "button.chat-source-jump",
  );
  expect(buttons).toHaveLength(1);
  expect(buttons[0].getAttribute("aria-label")).toBe("查看 2 处原文引用");
  await act(async () => buttons[0].click());
  const choice = document.querySelector<HTMLButtonElement>(
    `.chat-source-preview-card[aria-label="跳转到原文段落 ${block}"]`,
  );
  expect(choice).not.toBeNull();
  await act(async () => choice!.click());
  expect(api.validateEvidence).toHaveBeenCalledExactlyOnceWith(
    "doc",
    "answer",
    block,
  );
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    blockLocation,
    "searched excerpt",
  );
});
