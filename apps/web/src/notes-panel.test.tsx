// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { Annotation, Message } from "@neoread/core";
import { NotesPanel, documentOrder } from "./NotesPanel";
import { paper } from "./papers/fixtures";
import { tabCloseWarning } from "./document-tab-guards";
vi.mock("@neoread/api", () => ({
  api: {
    documentNote: vi.fn(async () => ({ body: "" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({ body })),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const mark = (patch: Partial<Annotation>): Annotation => ({
  id: "x",
  documentId: "p",
  kind: "highlight",
  location: { type: "pdf", page: 1 },
  quote: "",
  note: "",
  color: "#e6b94c",
  createdAt: "2026-10-01",
  ...patch,
});
const annotations = [
  mark({
    id: "late",
    quote: "page two",
    location: {
      type: "pdf",
      page: 2,
      rects: [{ x: 0, y: 0.1, width: 1, height: 0.1 }],
    },
  }),
  mark({
    id: "q-open",
    kind: "question",
    quote: "Why?",
    note: "Why does this converge?",
    location: {
      type: "pdf",
      page: 1,
      rects: [{ x: 0, y: 0.5, width: 1, height: 0.1 }],
    },
  }),
  mark({
    id: "q-done",
    kind: "question",
    note: "What is p?",
    answerId: "m1",
    location: {
      type: "pdf",
      page: 1,
      rects: [{ x: 0, y: 0.2, width: 1, height: 0.1 }],
    },
  }),
  mark({
    id: "note",
    kind: "note",
    quote: "a claim",
    note: "Check this",
    tags: ["existing-tag"],
    location: {
      type: "pdf",
      page: 1,
      rects: [{ x: 0, y: 0.05, width: 1, height: 0.1 }],
    },
  }),
];
const messages = [
  { id: "m1", role: "assistant", content: "**p** is the *probability*." },
] as Message[];
let root: Root, host: HTMLDivElement;
const handlers = {
  onGo: vi.fn(),
  onDelete: vi.fn(),
  onSave: vi.fn(async () => true),
  onAnswer: vi.fn(),
  onResolve: vi.fn(),
  onShowAnswer: vi.fn(),
  onExport: vi.fn(),
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <NotesPanel
        document={paper({ id: "p" })}
        annotations={annotations}
        messages={messages}
        deleting={new Set()}
        answering={new Set()}
        {...handlers}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const cards = () =>
  [...host.querySelectorAll<HTMLElement>(".note-card")].map(
    (card) => card.querySelector(".note-quote")!.textContent,
  );
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim().startsWith(label) || b.ariaLabel === label,
  )!;
const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

it("lists records in reading order", () => {
  expect(cards()).toEqual(["a claim", "第 1 页", "Why?", "page two"]);
  expect([...annotations].sort(documentOrder).map((a) => a.id)).toEqual([
    "note",
    "q-done",
    "q-open",
    "late",
  ]);
});

it("searches quoted text and note content within the active filter", async () => {
  const search = host.querySelector<HTMLInputElement>(
    'input[aria-label="搜索批注内容"]',
  )!;
  const enter = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  await enter("  CLAIM  ");
  expect(cards()).toEqual(["a claim"]);
  await enter("converge");
  expect(cards()).toEqual(["Why?"]);
  await act(async () => button("划线").click());
  expect(cards()).toEqual([]);
  expect(host.textContent).toContain("没有匹配的记录");
  await enter("");
  expect(cards()).toEqual(["page two"]);
  expect(host.querySelector(".notes-footer")?.textContent).toContain(
    "4 条记录",
  );
  await act(async () => button("导出").click());
  expect(handlers.onExport).toHaveBeenCalledOnce();
});

it("edits a note in place", async () => {
  await act(async () => button("编辑批注").click());
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="批注"]')!;
  await act(async () => type(field, "Checked twice"));
  expect(host.querySelector('[aria-label="标签"]')).toBeNull();
  expect(host.querySelector('[aria-label="按标签筛选"]')).toBeNull();
  expect(host.textContent).not.toContain("existing-tag");
  await act(async () => button("保存").click());
  expect(handlers.onSave).toHaveBeenCalledWith(annotations[3], {
    note: "Checked twice",
    tags: ["existing-tag"],
  });
  expect(host.querySelector('[aria-label="批注"]')).toBeNull();
});

it("saves the paper note after typing stops", async () => {
  await act(async () => button("论文笔记").click());
  const field = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="论文笔记"]',
  )!;
  await act(async () => type(field, "Main contribution"));
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(900));
  expect(api.saveDocumentNote).toHaveBeenCalledExactlyOnceWith(
    "p",
    "Main contribution",
  );
});

it("shares the raw draft with the expanded editor and preserves it on close", async () => {
  const expand = button("展开论文笔记");
  expect(expand).toBeDefined();
  await act(async () => expand.click());
  const mode = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".paper-note-toolbar button",
      ),
    ].find((node) => node.textContent?.trim() === label)!;
  await act(async () => mode("源码").click());
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="编辑论文笔记"]',
  )!;
  expect(editor).not.toBeNull();
  const raw = "# My note\n\n[原文](reader://document/p)\n\n**bold**";
  await act(async () => type(editor, raw));
  await act(async () => mode("编辑").click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.querySelector(".paper-note-rich h1")?.textContent).toBe(
        "My note",
      ),
    );
  });
  expect(
    document.querySelector(
      '.paper-note-rich [data-note-link="reader://document/p"]',
    )?.textContent,
  ).toBe("原文");
  expect(document.querySelector(".paper-note-rich a[href]")).toBeNull();
  const close = document.querySelector<HTMLButtonElement>(
    '[data-slot="dialog-close"]',
  )!;
  await act(async () => close.click());
  await act(async () => vi.advanceTimersByTime(1000));
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="论文笔记"]')
      ?.value,
  ).toBe(raw);
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith("p", raw);
  expect(document.activeElement).toBe(expand);
});

it("uses NeoRead links for new excerpts while retaining legacy note content", async () => {
  await act(async () => button("论文笔记").click());
  const field = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="论文笔记"]',
  )!;
  const legacy =
    "## Existing note\n\n[source](reader://open?id=old)\n\n$x_{1}$\n\n  ";
  await act(async () => type(field, legacy));
  await act(async () => button("摘录批注").click());
  const body = field.value;
  expect(body.startsWith(legacy.trimEnd() + "\n\n")).toBe(true);
  expect(body).toContain("neoread://open?id=p&annotation=note");
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith("p", body);
  expect(button("摘录批注").disabled).toBe(true);
});

it("warns before closing the tab with an unsaved inline note or paper note", async () => {
  await act(async () => button("编辑批注").click());
  expect(tabCloseWarning("p")).toBeNull();
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="批注"]')!;
  await act(async () => type(field, "Unsaved thought"));
  expect(tabCloseWarning("p")?.message).toContain("批注尚未保存");
  await act(async () => button("取消").click());
  expect(tabCloseWarning("p")).toBeNull();
  await act(async () => button("论文笔记").click());
  const note = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="论文笔记"]',
  )!;
  await act(async () => type(note, "Pending"));
  expect(tabCloseWarning("p")?.message).toContain("论文笔记");
  await act(async () => vi.advanceTimersByTime(900));
  expect(tabCloseWarning("p")).toBeNull();
});
