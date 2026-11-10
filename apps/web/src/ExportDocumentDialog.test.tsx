// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation } from "@neoread/core";
import { api } from "@neoread/api";
import { saveExportBlob } from "./download";
import { exportTranslatedPDF } from "./translated-pdf-export";
import { exportMarkdownFile, exportOriginal } from "./document-export";
import { ExportDocumentDialog } from "./ExportDocumentDialog";
import { paper } from "./papers/fixtures";
vi.mock("@neoread/api", () => ({
  api: { exportTranslation: vi.fn(), annotations: vi.fn(), messages: vi.fn() },
}));
vi.mock("./download", async (original) => ({
  ...(await original<typeof import("./download")>()),
  saveExportBlob: vi.fn(),
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
const selectFormat = async (label: string) => {
  for (const format of ["Markdown", "PDF"])
    if (
      (button(format).getAttribute("aria-pressed") === "true") !==
      (format === label)
    )
      await act(async () => button(format).click());
};
const selectTarget = async (label: string) => {
  for (const target of ["批注", "原文", "译文"])
    if (
      (button(target).getAttribute("aria-pressed") === "true") !==
      (target === label)
    )
      await act(async () => button(target).click());
};
const exportTarget = async (label: string) => {
  await selectTarget(label);
  await act(async () => button("导出").click());
};
const mount = async (load = false) =>
  act(async () =>
    root.render(
      <ExportDocumentDialog
        document={doc}
        annotations={load ? undefined : annotations}
        messages={load ? undefined : []}
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
  vi.mocked(api.annotations).mockResolvedValue(annotations);
  vi.mocked(api.messages).mockResolvedValue([]);
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
  await selectTarget("批注");
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
  expect(button("原文")).toBeTruthy();
  expect(button("译文")).toBeTruthy();
});
it.each(["Markdown", "PDF"])(
  "exports only selected annotations as %s",
  async (label) => {
    await mount();
    await selectTarget("批注");
    for (const name of ["批注", "高亮", "问题"])
      await act(async () =>
        document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!.click(),
      );
    await selectFormat(label);
    await exportTarget("批注");
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
  await selectTarget("批注");
  for (const checkbox of document.querySelectorAll<HTMLElement>(
    '[role="checkbox"]',
  ))
    await act(async () => checkbox.click());
  expect(button("导出").disabled).toBe(true);
  await selectTarget("原文");
  expect(button("导出").disabled).toBe(false);
});
it.each(["Markdown", "PDF"])(
  "exports original as %s without annotations",
  async (label) => {
    await mount();
    await selectFormat(label);
    await exportTarget("原文");
    expect(exportOriginal).toHaveBeenCalledWith(
      doc,
      label === "PDF" ? "pdf" : "markdown",
      expect.any(AbortSignal),
    );
    expect(exportMarkdownFile).not.toHaveBeenCalled();
    expect(api.exportTranslation).not.toHaveBeenCalled();
  },
);
it.each(["Markdown", "PDF"])("exports translation as %s", async (label) => {
  await mount();
  await selectFormat(label);
  await exportTarget("译文");
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
    expect(saveExportBlob).toHaveBeenCalledOnce();
  }
  expect(exportOriginal).not.toHaveBeenCalled();
  expect(exportMarkdownFile).not.toHaveBeenCalled();
});
it("cancels a format request and prevents its late download", async () => {
  let finish!: (blob: Blob) => void;
  vi.mocked(api.exportTranslation).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await exportTarget("译文");
  await selectFormat("Markdown");
  const signal = vi.mocked(api.exportTranslation).mock.calls[0][2]!;
  await act(async () =>
    activeDialog()
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click(),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => finish(new Blob(["late"])));
  expect(saveExportBlob).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(button("原文")).toBeTruthy();
});
it("keeps an export error visible and allows retry", async () => {
  vi.mocked(exportOriginal).mockRejectedValueOnce(new Error("正文尚未解析"));
  await mount();
  await exportTarget("原文");
  await selectFormat("Markdown");
  expect(activeDialog().textContent).toContain("正文尚未解析");
  expect(button("Markdown").disabled).toBe(false);
  expect(close).not.toHaveBeenCalled();
});

it("selects both formats inline and closes only after both finish", async () => {
  let finish!: (delivery: "download") => void;
  vi.mocked(exportOriginal)
    .mockResolvedValueOnce("download")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  await mount();
  await act(async () => button("PDF").click());
  expect(button("Markdown").getAttribute("aria-pressed")).toBe("true");
  expect(button("PDF").getAttribute("aria-pressed")).toBe("true");
  expect(exportOriginal).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await exportTarget("原文");
  expect(vi.mocked(exportOriginal).mock.calls.map((call) => call[1])).toEqual([
    "markdown",
    "pdf",
  ]);
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish("download"));
  expect(close).toHaveBeenCalledOnce();
});
it("disables all exports when all formats are deselected", async () => {
  await mount();
  await act(async () => button("Markdown").click());
  expect(button("导出").disabled).toBe(true);
});
it("cancels the batch without starting the remaining format", async () => {
  let finish!: (blob: Blob) => void;
  vi.mocked(api.exportTranslation).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await act(async () => button("PDF").click());
  await exportTarget("译文");
  await act(async () =>
    activeDialog()
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click(),
  );
  await act(async () => finish(new Blob(["late"])));
  expect(saveExportBlob).not.toHaveBeenCalled();
  expect(exportTranslatedPDF).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("exports all selected contents in both formats with one action", async () => {
  await mount(true);
  await act(async () => button("批注").click());
  await act(async () => button("译文").click());
  await act(async () => button("PDF").click());
  await act(async () => button("导出").click());
  expect(exportOriginal).toHaveBeenCalledTimes(2);
  expect(exportMarkdownFile).toHaveBeenCalledTimes(2);
  expect(api.annotations).toHaveBeenCalledExactlyOnceWith(
    doc.id,
    expect.any(AbortSignal),
  );
  expect(api.messages).toHaveBeenCalledExactlyOnceWith(
    doc.id,
    expect.any(AbortSignal),
  );
  expect(api.exportTranslation).toHaveBeenCalledOnce();
  expect(exportTranslatedPDF).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("does not export after closing while annotation data is loading", async () => {
  let finish!: (value: Annotation[]) => void;
  vi.mocked(api.annotations).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount(true);
  await exportTarget("批注");
  const signal = vi.mocked(api.annotations).mock.calls[0][1]!;
  await act(async () =>
    activeDialog()
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click(),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => finish(annotations));
  expect(exportMarkdownFile).not.toHaveBeenCalled();
});
it("keeps data loading failures retryable", async () => {
  vi.mocked(api.annotations).mockRejectedValueOnce(new Error("读取批注失败"));
  await mount(true);
  await exportTarget("批注");
  expect(activeDialog().textContent).toContain("读取批注失败");
  expect(exportMarkdownFile).not.toHaveBeenCalled();
  await act(async () => button("导出").click());
  expect(exportMarkdownFile).toHaveBeenCalledOnce();
});
it("waits for each of four exports before starting the next", async () => {
  let finish!: (delivery: "download") => void;
  vi.mocked(exportOriginal).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let saveTranslation!: () => void;
  vi.mocked(saveExportBlob).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        saveTranslation = resolve;
      }),
  );
  await mount();
  await act(async () => button("译文").click());
  await act(async () => button("PDF").click());
  await act(async () => button("导出").click());
  expect(exportOriginal).toHaveBeenCalledTimes(1);
  expect(api.exportTranslation).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish("download"));
  expect(exportOriginal).toHaveBeenCalledTimes(2);
  expect(saveExportBlob).toHaveBeenCalledOnce();
  expect(exportTranslatedPDF).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => saveTranslation());
  expect(exportTranslatedPDF).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("stops the remaining files when a native save is cancelled", async () => {
  vi.mocked(saveExportBlob).mockRejectedValueOnce(
    new DOMException("已取消导出", "AbortError"),
  );
  await mount();
  await selectTarget("译文");
  await act(async () => button("PDF").click());
  await act(async () => button("导出").click());
  expect(exportTranslatedPDF).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(activeDialog().querySelector('[role="alert"]')).toBeNull();
  expect(button("导出").disabled).toBe(false);
});
it("requires at least one content selection", async () => {
  await mount();
  await act(async () => button("原文").click());
  expect(button("导出").disabled).toBe(true);
});
