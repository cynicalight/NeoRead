// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@neoread/core";
const mocks = vi.hoisted(() => ({
  markdown: vi.fn(),
  render: vi.fn(),
  print: vi.fn(),
  log: vi.fn(),
  download: vi.fn(),
  toast: {
    loading: vi.fn(() => "export"),
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@neoread/api", () => ({ api: { exportTranslation: mocks.markdown } }));
vi.mock("./markdown-pdf", () => ({
  markdownPrintHTML: mocks.render,
  printMarkdownInBrowser: mocks.print,
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: mocks.log }));
vi.mock("./download", async (original) => ({
  ...(await original<typeof import("./download")>()),
  saveExportBlob: mocks.download,
  fileTitle: () => "document",
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
import {
  exportTranslatedPDF,
  exportTranslatedPDFWithToast,
  exportTranslatedMarkdownWithToast,
} from "./translated-pdf-export";
const doc = { id: "private", type: "pdf", title: "PRIVATE" } as Document;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.markdown.mockResolvedValue({ text: async () => "# 译文\n\n正文" });
  mocks.render.mockReturnValue("<html>译文</html>");
  window.neoreadDesktop = {
    markdownPDF: vi.fn().mockResolvedValue(new Uint8Array([1, 2])),
    cancelMarkdownPDF: vi.fn().mockResolvedValue(undefined),
  } as unknown as NonNullable<Window["neoreadDesktop"]>;
});
afterEach(() => {
  delete window.neoreadDesktop;
});
it("renders the same Markdown export without opening the source PDF", async () => {
  const signal = new AbortController().signal;
  expect(await exportTranslatedPDF(doc, signal, vi.fn())).toEqual({
    delivery: "download",
  });
  expect(mocks.markdown).toHaveBeenCalledWith(doc.id, "markdown", signal);
  expect(mocks.render).toHaveBeenCalledWith("# 译文\n\n正文", "document-译文");
  expect(window.neoreadDesktop!.markdownPDF).toHaveBeenCalledWith(
    expect.any(String),
    "<html>译文</html>",
  );
  expect(mocks.download).toHaveBeenCalledOnce();
});
it.each(["snapshot", "layout", "save", "download"])(
  "redacts %s failures",
  async (reason) => {
    const error = new Error("PRIVATE BODY token=secret");
    if (reason === "snapshot") mocks.markdown.mockRejectedValueOnce(error);
    if (reason === "layout")
      mocks.render.mockImplementationOnce(() => {
        throw error;
      });
    if (reason === "save")
      vi.mocked(window.neoreadDesktop!.markdownPDF!).mockRejectedValueOnce(
        error,
      );
    if (reason === "download")
      mocks.download.mockImplementationOnce(() => {
        throw error;
      });
    await expect(
      exportTranslatedPDF(doc, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(error.message);
    const failures = mocks.log.mock.calls
      .map(([e]) => e)
      .filter((e) => e.event.endsWith("failed"));
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain(`reasonCode=${reason}`);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/PRIVATE|secret/);
  },
);
it("cancels native rendering and prevents late downloads", async () => {
  const controller = new AbortController();
  vi.mocked(window.neoreadDesktop!.markdownPDF!).mockImplementation(
    async () => {
      controller.abort();
      return new Uint8Array([1]);
    },
  );
  await expect(
    exportTranslatedPDF(doc, controller.signal, vi.fn()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(window.neoreadDesktop!.cancelMarkdownPDF).toHaveBeenCalledOnce();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({ event: "pdf.translation_export.cancelled" }),
  );
});
it("does not read content for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    exportTranslatedPDF(doc, controller.signal, vi.fn()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.markdown).not.toHaveBeenCalled();
});
it("reports browser print separately from a downloaded PDF", async () => {
  delete window.neoreadDesktop;
  await exportTranslatedPDFWithToast(doc);
  expect(mocks.print).toHaveBeenCalledOnce();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.toast.success).not.toHaveBeenCalled();
  expect(mocks.toast.info).toHaveBeenCalledWith(
    "打印窗口已关闭",
    expect.any(Object),
  );
});
it("reports menu export failure without an unhandled rejection", async () => {
  mocks.markdown.mockRejectedValueOnce(new Error("译文读取失败"));
  await exportTranslatedPDFWithToast(doc);
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "译文读取失败",
    expect.any(Object),
  );
  expect(mocks.download).not.toHaveBeenCalled();
});

it("downloads the Markdown snapshot without rendering it", async () => {
  const blob = new Blob(["# 译文\n\n$x^2$"]);
  mocks.markdown.mockResolvedValueOnce(blob);
  await exportTranslatedMarkdownWithToast(doc);
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith(
    blob,
    "document-译文.md",
    expect.any(AbortSignal),
  );
  expect(mocks.render).not.toHaveBeenCalled();
  expect(window.neoreadDesktop!.markdownPDF).not.toHaveBeenCalled();
});
