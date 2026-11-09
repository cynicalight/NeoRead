// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation } from "@neoread/core";
import { api } from "@neoread/api";
import { downloadBlob } from "./download";
import { exportTranslatedPDF } from "./translated-pdf-export";
import { exportMarkdownFile, exportOriginal } from "./document-export";
import { ExportDocumentDialog } from "./ExportDocumentDialog";
import { paper } from "./papers/fixtures";
vi.mock("@neoread/api", () => ({ api: { exportTranslation: vi.fn() } }));
vi.mock("./download", () => ({
  downloadBlob: vi.fn(),
  fileTitle: (title: string) => title,
}));
vi.mock("./translated-pdf-export", () => ({ exportTranslatedPDF: vi.fn() }));
vi.mock("./document-export", async (original) => ({
  ...(await original<typeof import("./document-export")>()),
  exportMarkdownFile: vi.fn(),
  exportOriginal: vi.fn(),
}));
const doc = paper({ id: "doc", title: "论文" });
const annotations: Annotation[] = (
  ["note", "underline", "highlight", "question"] as const
).map((kind, i) => ({
  id: String(i),
  documentId: doc.id,
  kind,
  location: { type: "pdf", page: 1 },
  quote: `${kind}-quote`,
  note: `${kind}-note`,
  color: "#fff",
  createdAt: "",
}));
let root: Root, host: HTMLDivElement;
const close = vi.fn();
const activeDialog = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
const button = (text: string) =>
  [...activeDialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
const mount = async () =>
  act(async () =>
    root.render(
      <ExportDocumentDialog
        document={doc}
        annotations={annotations}
        messages={[]}
        onClose={close}
      />,
    ),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.mocked(exportMarkdownFile).mockResolvedValue("download");
  vi.mocked(exportOriginal).mockResolvedValue("download");
  vi.mocked(exportTranslatedPDF).mockResolvedValue({ delivery: "download" });
  vi.mocked(api.exportTranslation).mockResolvedValue(new Blob(["译文"]));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("keeps only the four annotation kinds and separates original and translation", async () => {
  await mount();
  expect(
    [...document.querySelectorAll('[role="checkbox"]')].map((el) =>
      el.getAttribute("aria-label"),
    ),
  ).toEqual(["批注", "划线", "高亮", "问题"]);
  for (const text of [
    "论文信息",
    "论文笔记",
    "AI 对话",
    "书签",
    "包含译文中的原文图片",
    "保存为 Markdown",
    "按 Markdown 默认字号",
  ])
    expect(document.body.textContent).not.toContain(text);
  expect(button("导出原文")).toBeTruthy();
  expect(button("导出译文")).toBeTruthy();
});
it.each(["Markdown", "PDF"])(
  "exports only selected annotations as %s",
  async (label) => {
    await mount();
    for (const name of ["批注", "高亮", "问题"])
      await act(async () =>
        document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!.click(),
      );
    await act(async () => button(label).click());
    expect(exportMarkdownFile).toHaveBeenCalledWith(
      expect.stringContaining("underline-quote"),
      "论文-批注",
      label === "PDF" ? "pdf" : "markdown",
      expect.any(AbortSignal),
    );
    const markdown = vi.mocked(exportMarkdownFile).mock.calls[0][0];
    for (const excluded of ["note-quote", "highlight-quote", "question-quote"])
      expect(markdown).not.toContain(excluded);
    expect(close).toHaveBeenCalledOnce();
  },
);
it("disables annotation formats when no kinds are selected", async () => {
  await mount();
  for (const checkbox of document.querySelectorAll<HTMLElement>(
    '[role="checkbox"]',
  ))
    await act(async () => checkbox.click());
  expect(button("Markdown").disabled).toBe(true);
  expect(button("PDF").disabled).toBe(true);
  expect(button("导出原文").disabled).toBe(false);
});
it.each(["Markdown", "PDF"])(
  "opens original format selection and exports %s without annotations",
  async (label) => {
    await mount();
    await act(async () => button("导出原文").click());
    await act(async () => button(label).click());
    expect(exportOriginal).toHaveBeenCalledWith(
      doc,
      label === "PDF" ? "pdf" : "markdown",
      expect.any(AbortSignal),
    );
    expect(exportMarkdownFile).not.toHaveBeenCalled();
    expect(api.exportTranslation).not.toHaveBeenCalled();
  },
);
it.each(["Markdown", "PDF"])(
  "opens translation format selection and exports %s",
  async (label) => {
    await mount();
    await act(async () => button("导出译文").click());
    await act(async () => button(label).click());
    if (label === "PDF")
      expect(exportTranslatedPDF).toHaveBeenCalledWith(
        doc,
        expect.any(AbortSignal),
        expect.any(Function),
      );
    else {
      expect(api.exportTranslation).toHaveBeenCalledWith(
        doc.id,
        "markdown",
        expect.any(AbortSignal),
      );
      expect(downloadBlob).toHaveBeenCalledOnce();
    }
    expect(exportOriginal).not.toHaveBeenCalled();
    expect(exportMarkdownFile).not.toHaveBeenCalled();
  },
);
it("cancels a format request and prevents its late download", async () => {
  let finish!: (blob: Blob) => void;
  vi.mocked(api.exportTranslation).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await act(async () => button("导出译文").click());
  await act(async () => button("Markdown").click());
  const signal = vi.mocked(api.exportTranslation).mock.calls[0][2]!;
  await act(async () => button("取消").click());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(new Blob(["late"])));
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(button("导出原文")).toBeTruthy();
});
it("keeps an export error visible and allows retry", async () => {
  vi.mocked(exportOriginal).mockRejectedValueOnce(new Error("正文尚未解析"));
  await mount();
  await act(async () => button("导出原文").click());
  await act(async () => button("Markdown").click());
  expect(activeDialog().textContent).toContain("正文尚未解析");
  expect(button("Markdown").disabled).toBe(false);
  expect(close).not.toHaveBeenCalled();
});
