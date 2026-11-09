import { afterEach, expect, it, vi } from "vitest";
import type { Annotation, PDFBlock } from "@neoread/core";
import { api } from "@neoread/api";
import { saveExportBlob } from "./download";
import { paper } from "./papers/fixtures";
import {
  annotationMarkdown,
  exportOriginal,
  exportMarkdownFile,
  originalMarkdown,
} from "./document-export";
vi.mock("@neoread/api", () => ({
  api: { blocks: vi.fn(), epubBlocks: vi.fn() },
  publicationURL: () => "/original.pdf",
}));
vi.mock("./download", async (original) => ({
  ...(await original<typeof import("./download")>()),
  saveExportBlob: vi.fn(),
  fileTitle: (s: string) => s,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const doc = paper({ id: "doc", title: "Title" });
const block = (
  id: string,
  page: number,
  text: string,
  label = "text",
): PDFBlock => ({
  id,
  page,
  text,
  label,
  bounds: { x: 0, y: 0, width: 1, height: 1 },
});
it("exports original paragraphs in page order without page decorations", () => {
  const result = originalMarkdown(doc, [
    block("a", 1, "Original"),
    block("b", 1, "Header", "header"),
    block("c", 2, "Next"),
  ]);
  expect(result).toContain("## 第 1 页\n\nOriginal\n\n## 第 2 页\n\nNext");
  expect(result).not.toContain("Header");
  expect(() => originalMarkdown(doc, [])).toThrow("正文尚未解析");
});
it("downloads the original PDF bytes without calling annotation or translation APIs", async () => {
  const blob = new Blob(["original bytes"], { type: "application/pdf" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }),
  );
  await exportOriginal(doc, "pdf", new AbortController().signal);
  expect(saveExportBlob).toHaveBeenCalledWith(
    blob,
    "Title-原文.pdf",
    expect.any(AbortSignal),
  );
  expect(api.blocks).not.toHaveBeenCalled();
});
it("does not download an original PDF returned after cancellation", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => {
        controller.abort();
        return new Blob(["late"]);
      },
    }),
  );
  await expect(
    exportOriginal(doc, "pdf", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(saveExportBlob).not.toHaveBeenCalled();
});
it("exports EPUB source Markdown using the same cancellation signal", async () => {
  vi.mocked(api.epubBlocks).mockResolvedValue([
    {
      id: "a",
      label: "text",
      text: "EPUB source",
      location: { type: "epub", href: "chapter.xhtml" },
    },
  ]);
  const signal = new AbortController().signal;
  await exportOriginal({ ...doc, type: "epub" }, "markdown", signal);
  expect(api.epubBlocks).toHaveBeenCalledWith(doc.id, signal);
  expect(await vi.mocked(saveExportBlob).mock.calls[0][0].text()).toContain(
    "EPUB source",
  );
  expect(saveExportBlob).toHaveBeenCalledWith(
    expect.any(Blob),
    "Title-原文.md",
    signal,
  );
});
it("includes question answers but excludes unrelated chat, bookmarks and other annotation kinds", () => {
  const question = {
    id: "q",
    kind: "question",
    location: { type: "pdf", page: 1 },
    quote: "quote",
    note: "question",
    answerId: "answer",
  } as Annotation;
  const result = annotationMarkdown(
    doc,
    [question, { ...question, id: "h", kind: "highlight", quote: "excluded" }],
    [
      { id: "answer", role: "assistant", content: "answer text" },
      { id: "chat", role: "assistant", content: "unrelated chat" },
    ] as any,
    ["question"],
  );
  expect(result).toContain("answer text");
  expect(result).not.toContain("unrelated chat");
  expect(result).not.toContain("excluded");
});

it("cancels annotation PDF rendering without downloading a late native result", async () => {
  const controller = new AbortController();
  const cancel = vi.fn(async () => {});
  vi.stubGlobal("window", {
    neoreadDesktop: {
      cancelMarkdownPDF: cancel,
      markdownPDF: vi.fn(async () => {
        controller.abort();
        return new Uint8Array([1]);
      }),
    },
  });
  await expect(
    exportMarkdownFile("# 批注", "annotations", "pdf", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(saveExportBlob).not.toHaveBeenCalled();
});
