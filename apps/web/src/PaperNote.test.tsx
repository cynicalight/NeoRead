// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { PaperNote } from "./PaperNote";
import {
  getPaperNote,
  flushPaperNote,
  flushPaperNotes,
} from "./paper-note-state";
vi.mock("@reader/api", () => ({
  api: {
    documentNote: vi.fn(async () => ({ body: "original", updatedAt: "" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({
      body,
      updatedAt: "",
    })),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let root: Root,
  host: HTMLDivElement,
  id = 0;
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === text || node.ariaLabel === text,
  )!;
const type = (field: HTMLTextAreaElement, body: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(field, body);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const field = () =>
  host.querySelector<HTMLTextAreaElement>('textarea[aria-label="论文笔记"]')!;
const richField = () =>
  document.querySelector<HTMLDivElement>(".paper-note-rich .ProseMirror");
const waitForRich = async () =>
  act(async () => {
    await vi.waitFor(() => expect(richField()).not.toBeNull());
  });
const mount = async () =>
  act(async () =>
    root.render(<PaperNote documentId={`editor-${++id}`} annotations={[]} />),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
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
it("keeps a failed read disabled and allows retrying without writing an empty note", async () => {
  vi.mocked(api.documentNote).mockRejectedValueOnce(new Error("offline"));
  await mount();
  await act(async () => button("论文笔记").click());
  expect(field().disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "offline",
  );
  await act(async () => button("重试").click());
  expect(field().disabled).toBe(false);
  expect(field().value).toBe("original");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
});
it("shows an unsaved draft on failure and retries it explicitly", async () => {
  await mount();
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(new Error("offline"));
  await act(async () => type(field(), "retained draft"));
  expect(host.textContent).toContain("待保存");
  await act(async () =>
    field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
  );
  expect(field().value).toBe("retained draft");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "保存失败",
  );
  await act(async () => button("重试").click());
  expect(host.textContent).toContain("已保存");
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(
    expect.any(String),
    "retained draft",
  );
});
it("opens the rich editor by default and preserves exact Markdown through source switching", async () => {
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: "##  Original\n\n* list\n\n$x_{1}$\n",
    updatedAt: "",
  });
  await mount();
  await act(async () => button("展开论文笔记").click());
  expect(button("源码")).toBeDefined();
  await act(async () => button("源码").click());
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="编辑论文笔记"]',
  )!;
  expect(editor.value).toBe("##  Original\n\n* list\n\n$x_{1}$\n");
  await act(async () => type(editor, "## Latest source\n"));
  await act(async () => button("编辑").click());
  await act(async () => button("源码").click());
  expect(
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="编辑论文笔记"]',
    )!.value,
  ).toBe("## Latest source\n");
});

it("does not save or normalize a note merely by opening, switching modes, focusing and closing", async () => {
  const original = "##  Original\n\n* list\n\n$x_{1}$\n";
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: original,
    updatedAt: "",
  });
  await mount();
  await act(async () => button("展开论文笔记").click());
  await waitForRich();
  await act(async () => richField()!.focus());
  await act(async () => button("源码").click());
  expect(
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="编辑论文笔记"]',
    )!.value,
  ).toBe(original);
  await act(async () => button("编辑").click());
  await waitForRich();
  await act(async () => button("Close").click());
  expect(field().value).toBe(original);
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
});

it("shares mixed Chinese/English rich edits immediately with source, export and native-close flush", async () => {
  await mount();
  const noteId = `editor-${id}`;
  await act(async () => button("展开论文笔记").click());
  await waitForRich();
  await act(async () => {
    richField()!.querySelector("p")!.textContent = "最新 draft 中文 English";
    richField()!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "中文 English",
      }),
    );
    await Promise.resolve(); // ProseMirror's native DOM mutation observer
  });
  expect(getPaperNote(noteId).getSnapshot().body).toContain(
    "最新 draft 中文 English",
  );
  await act(async () => button("源码").click());
  expect(
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="编辑论文笔记"]',
    )!.value,
  ).toContain("最新 draft 中文 English");
  await act(async () =>
    type(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="编辑论文笔记"]',
      )!,
      "## Source 中文\n\n$x_{2}$\n",
    ),
  );
  await act(async () => button("编辑").click());
  await waitForRich();
  expect(richField()!.querySelector("h2")?.textContent).toBe("Source 中文");
  expect(richField()!.querySelector(".katex")).not.toBeNull();
  await act(async () => {
    await flushPaperNotes();
  });
  expect(await flushPaperNote(noteId)).toBe("## Source 中文\n\n$x_{2}$\n");
  await act(async () => button("Close").click());
  await act(async () => button("展开论文笔记").click());
  await waitForRich();
  expect(richField()!.textContent).toContain("Source 中文");
});

it("keeps unsupported existing HTML intact in the source fallback", async () => {
  const original = "before\n\n<div data-x=old>keep this</div>\n\nafter";
  vi.mocked(api.documentNote).mockResolvedValueOnce({
    body: original,
    updatedAt: "",
  });
  await mount();
  await act(async () => button("展开论文笔记").click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("暂不支持"),
    );
  });
  expect(
    document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="编辑论文笔记"]',
    )!.value,
  ).toBe(original);
  expect(document.querySelector("[data-x=old]")).toBeNull();
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
});

it("isolates pending editor mounts under StrictMode and fast source switching", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <PaperNote documentId={`editor-${++id}`} annotations={[]} />
      </StrictMode>,
    ),
  );
  await act(async () => button("展开论文笔记").click());
  await act(async () => button("源码").click());
  const source = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="编辑论文笔记"]',
  )!;
  await act(async () => type(source, "latest 快速切换"));
  await act(async () => button("编辑").click());
  await waitForRich();
  expect(
    document.querySelectorAll(".paper-note-rich .ProseMirror"),
  ).toHaveLength(1);
  expect(richField()!.textContent).toContain("latest 快速切换");
  await act(async () => button("Close").click());
  expect(
    document.querySelectorAll(".paper-note-rich .ProseMirror"),
  ).toHaveLength(0);
});
it("isolates editor keyboard commands from global window shortcuts", async () => {
  await mount();
  await act(async () => button("展开论文笔记").click());
  await act(async () => button("源码").click());
  const globalShortcut = vi.fn();
  window.addEventListener("keydown", globalShortcut);
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="编辑论文笔记"]',
  )!;
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    ),
  );
  window.removeEventListener("keydown", globalShortcut);
  expect(globalShortcut).not.toHaveBeenCalled();
});
