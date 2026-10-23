// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { PaperNote } from "./PaperNote";
vi.mock("@neoread/api", () => ({
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
const mount = async () =>
  act(async () =>
    root.render(<PaperNote documentId={`editor-${++id}`} annotations={[]} />),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
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
it("keeps the draft when switching narrow-screen Edit and Preview tabs", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  await mount();
  await act(async () => button("展开论文笔记").click());
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="编辑论文笔记"]',
  )!;
  await act(async () => type(editor, "## Narrow draft"));
  await act(async () => button("预览").click());
  expect(document.querySelector(".paper-note-preview h2")?.textContent).toBe(
    "Narrow draft",
  );
  expect(button("预览").getAttribute("aria-selected")).toBe("true");
  await act(async () => button("编辑").click());
  expect(editor.value).toBe("## Narrow draft");
});
it("isolates editor keyboard commands from global window shortcuts", async () => {
  await mount();
  await act(async () => button("展开论文笔记").click());
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
