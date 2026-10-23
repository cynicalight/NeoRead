// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, Message } from "@reader/core";
import { api } from "@reader/api";
import { downloadBlob, downloadText } from "./download";
import { copyText } from "./chat/clipboard";
import { exportAnnotatedPDFWithToast } from "./annotated-pdf-export";
import { ExportDocumentDialog } from "./ExportDocumentDialog";
import { paper } from "./papers/fixtures";

vi.mock("@reader/api", () => ({
  api: {
    documentNote: vi.fn(),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({ body })),
    translations: vi.fn(),
    exportTranslation: vi.fn(),
  },
}));
vi.mock("./download", () => ({
  downloadBlob: vi.fn(),
  downloadText: vi.fn(),
  fileTitle: (title: string) => title,
}));
vi.mock("./chat/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("./annotated-pdf-export", () => ({
  exportAnnotatedPDFWithToast: vi.fn(async () => {}),
}));

let root: Root, host: HTMLDivElement;
const close = vi.fn();
const doc = paper({ id: "doc", title: "示例" });
const annotation: Annotation = {
  id: "a",
  documentId: "doc",
  kind: "note",
  location: { type: "pdf", page: 1 },
  quote: "引用原文",
  note: "批注内容",
  color: "#fff",
  createdAt: "2026-10-18",
};
const messages: Message[] = [
  {
    id: "m",
    documentId: "doc",
    role: "assistant",
    content: "独立对话",
    createdAt: "2026-10-18",
  },
];
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
const checkbox = (label: string) =>
  [...document.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith(label))!
    .querySelector<HTMLElement>('[role="checkbox"]')!;
const mount = async () =>
  act(async () =>
    root.render(
      <ExportDocumentDialog
        document={doc}
        annotations={[annotation]}
        messages={messages}
        onClose={close}
      />,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  });
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.documentNote).mockResolvedValue({
    body: "论文笔记正文",
    updatedAt: "2026-10-18",
  });
  vi.mocked(api.translations).mockResolvedValue([
    {
      blockId: "b",
      sourceHash: "h",
      status: "complete",
      sentences: [{ source: "source", target: "译文正文" }],
    },
  ]);
  vi.mocked(api.exportTranslation).mockResolvedValue(new Blob(["export"]));
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

it("combines translation and selected notes in one Markdown download", async () => {
  await mount();
  await act(async () => button("导出").click());
  const [id, format, signal, notes] = vi.mocked(api.exportTranslation).mock
    .calls[0];
  expect([id, format]).toEqual(["doc", "markdown"]);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(notes).toContain("论文笔记正文");
  expect(notes).toContain("批注内容");
  expect(notes).not.toContain("# 示例");
  expect(notes).not.toContain("独立对话");
  expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "示例-导出.md");
  expect(downloadText).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("includes only checked content in a ZIP and copies Markdown even with images checked", async () => {
  localStorage.setItem(
    "reader.notes-export",
    JSON.stringify(["translation", "chat"]),
  );
  await mount();
  await act(async () => checkbox("包含译文中的原文图片").click());
  const blob = Object.assign(new Blob(), { text: async () => "译文与对话" });
  vi.mocked(api.exportTranslation).mockResolvedValue(blob);
  await act(async () => button("复制").click());
  expect(api.exportTranslation).toHaveBeenLastCalledWith(
    "doc",
    "markdown",
    expect.any(AbortSignal),
    expect.stringContaining("独立对话"),
  );
  expect(copyText).toHaveBeenCalledWith("译文与对话", "已复制 Markdown");
  await act(async () => button("导出").click());
  expect(api.exportTranslation).toHaveBeenLastCalledWith(
    "doc",
    "zip",
    expect.any(AbortSignal),
    expect.stringContaining("独立对话"),
  );
  const notes = vi.mocked(api.exportTranslation).mock.lastCall![3]!;
  expect(notes).not.toContain("论文笔记正文");
  expect(notes).not.toContain("批注内容");
  expect(downloadBlob).toHaveBeenCalledWith(blob, "示例-导出.zip");
});

it("preserves old note preferences and exports notes without calling translation export", async () => {
  localStorage.setItem("reader.notes-export", JSON.stringify(["paperNote"]));
  await mount();
  expect(checkbox("译文").getAttribute("aria-checked")).toBe("false");
  await act(async () => button("导出").click());
  expect(api.exportTranslation).not.toHaveBeenCalled();
  expect(downloadText).toHaveBeenCalledWith(
    "# 示例\n\n## 论文笔记\n\n论文笔记正文\n",
    "示例-导出.md",
    "text/markdown",
  );
});

it("does not retain ZIP mode after translation is unchecked and disables an empty selection", async () => {
  localStorage.setItem(
    "reader.notes-export",
    JSON.stringify(["translation", "paperNote"]),
  );
  await mount();
  await act(async () => checkbox("包含译文中的原文图片").click());
  await act(async () => checkbox("译文").click());
  expect(document.body.textContent).not.toContain("包含译文中的原文图片");
  await act(async () => button("复制").click());
  expect(api.exportTranslation).not.toHaveBeenCalled();
  expect(copyText).toHaveBeenCalledWith(
    expect.stringContaining("论文笔记正文"),
    "已复制 Markdown",
  );
  await act(async () => checkbox("论文笔记").click());
  expect(button("复制").disabled).toBe(true);
  expect(button("导出").disabled).toBe(true);
});

it("blocks missing selected notes instead of silently exporting an incomplete file", async () => {
  vi.mocked(api.documentNote).mockRejectedValueOnce(new Error("unavailable"));
  await mount();
  expect(button("导出").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "笔记读取或保存失败",
  );
  await act(async () => button("重试读取").click());
  expect(button("导出").disabled).toBe(false);
  await act(async () => button("导出").click());
  expect(api.exportTranslation).toHaveBeenLastCalledWith(
    "doc",
    "markdown",
    expect.any(AbortSignal),
    expect.stringContaining("论文笔记正文"),
  );
});

it("allows notes-only export after a translation read failure", async () => {
  vi.mocked(api.translations).mockRejectedValueOnce(new Error("unavailable"));
  await mount();
  expect(button("导出").disabled).toBe(true);
  await act(async () => checkbox("译文").click());
  await act(async () => button("导出").click());
  expect(downloadText).toHaveBeenCalledOnce();
  expect(api.exportTranslation).not.toHaveBeenCalled();
});

it("keeps notes export available when there are no completed translations", async () => {
  vi.mocked(api.translations).mockResolvedValueOnce([]);
  await mount();
  expect(checkbox("译文").getAttribute("aria-checked")).toBe("false");
  expect(checkbox("译文").getAttribute("aria-disabled")).toBe("true");
  await act(async () => button("导出").click());
  expect(downloadText).toHaveBeenCalledWith(
    expect.stringContaining("批注内容"),
    "示例-导出.md",
    "text/markdown",
  );
  expect(api.exportTranslation).not.toHaveBeenCalled();
});

it("keeps a failed export open for retry", async () => {
  await mount();
  vi.mocked(api.exportTranslation).mockRejectedValueOnce(
    new Error("无法打包译文图片"),
  );
  await act(async () => button("导出").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "无法打包译文图片",
  );
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => button("导出").click());
  expect(downloadBlob).toHaveBeenCalledOnce();
});

it("cancels an in-flight export and ignores its late response", async () => {
  await mount();
  let resolve!: (blob: Blob) => void;
  vi.mocked(api.exportTranslation).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => button("导出").click());
  expect(button("正在导出…").disabled).toBe(true);
  const signal = vi.mocked(api.exportTranslation).mock.calls[0][2]!;
  await act(async () => button("取消").click());
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(new Blob(["late response"])));
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("exports only selected annotation kinds into the original PDF", async () => {
  localStorage.setItem("reader.notes-export", JSON.stringify(["notes"]));
  await mount();
  await act(async () => button("导出 PDF").click());
  expect(exportAnnotatedPDFWithToast).toHaveBeenCalledWith(doc, ["note"]);
  await act(async () => checkbox("批注").click());
  expect(button("导出 PDF").disabled).toBe(true);
});

it("flushes the shared draft before loading counts and again at the actual export", async () => {
  const { getPaperNote } = await import("./paper-note-state");
  const note = getPaperNote(doc.id);
  const release = note.subscribe(() => {});
  await note.load();
  note.edit("draft before dialog");
  await mount();
  expect(api.saveDocumentNote).toHaveBeenLastCalledWith(
    doc.id,
    "draft before dialog",
  );
  note.edit("newer draft after dialog");
  await act(async () => button("导出").click());
  expect(api.exportTranslation).toHaveBeenLastCalledWith(
    doc.id,
    "markdown",
    expect.any(AbortSignal),
    expect.stringContaining("newer draft after dialog"),
  );
  release();
});

it("blocks stale exports on save failure and supports retry without losing the draft", async () => {
  const { getPaperNote } = await import("./paper-note-state");
  const note = getPaperNote(doc.id);
  const release = note.subscribe(() => {});
  await note.load();
  await mount();
  note.edit("must not lose this draft");
  vi.mocked(api.saveDocumentNote).mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("导出").click());
  expect(api.exportTranslation).not.toHaveBeenCalled();
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "offline",
  );
  await act(async () => button("导出").click());
  expect(api.exportTranslation).toHaveBeenLastCalledWith(
    doc.id,
    "markdown",
    expect.any(AbortSignal),
    expect.stringContaining("must not lose this draft"),
  );
  release();
});
