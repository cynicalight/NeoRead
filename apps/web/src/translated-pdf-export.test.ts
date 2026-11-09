import { beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@neoread/core";
import { PDFExportError, exportFailure } from "./translation/pdf-export-error";
const mocks = vi.hoisted(() => ({
  blocks: vi.fn(),
  translations: vi.fn(),
  engine: vi.fn(),
  log: vi.fn(),
  download: vi.fn(),
  toast: {
    loading: vi.fn(
      (
        _message: string,
        _options?: {
          id?: string | number;
          action?: { label: string; onClick: () => void };
        },
      ) => "export",
    ),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@neoread/api", () => ({
  api: { blocks: mocks.blocks, translations: mocks.translations },
  publicationURL: () => "/private-document.pdf",
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("./translation/pdf-export", () => ({ translatedPDF: mocks.engine }));
vi.mock("./diagnostics", () => ({ reportDiagnostic: mocks.log }));
vi.mock("./download", () => ({
  downloadBlob: mocks.download,
  fileTitle: () => "document",
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
import {
  exportTranslatedPDF,
  exportTranslatedPDFWithToast,
} from "./translated-pdf-export";
const doc = {
  id: "private-document",
  type: "pdf",
  title: "PRIVATE TITLE",
} as Document;
const secret =
  "PRIVATE BODY token=secret https://private.example /Users/private/file.pdf";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.blocks.mockResolvedValue([]);
  mocks.translations.mockResolvedValue([]);
  mocks.engine.mockResolvedValue({
    bytes: new Uint8Array(),
    translated: 1,
    pages: 1,
    issues: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  );
});
it.each([
  "snapshot",
  "font_load",
  "pdf_decode",
  "encrypted_pdf",
  "font_embed",
  "layout",
  "no_translated_blocks",
  "save",
  "download",
] as const)(
  "logs a controlled %s failure without exception contents",
  async (reason) => {
    const raw = new Error(secret);
    if (reason === "snapshot") mocks.blocks.mockRejectedValue(raw);
    else if (reason === "font_load") vi.mocked(fetch).mockRejectedValue(raw);
    else if (reason === "download")
      mocks.download.mockImplementation(() => {
        throw raw;
      });
    else mocks.engine.mockRejectedValue(new PDFExportError(reason, raw));
    await expect(
      exportTranslatedPDF(doc, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(secret);
    const events = mocks.log.mock.calls.map(([event]) => event);
    const failures = events.filter(
      (event) => event.event === "pdf.translation_export.failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: "error",
      requestId: events[0].requestId,
    });
    expect(failures[0].detail).toContain(`reasonCode=${reason}`);
    expect(failures[0].detail).toContain("errorCode=");
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE|secret|private-document|private.example|Users/,
    );
  },
);
it("recognizes only explicit encrypted-PDF error names during decoding", () => {
  const error = new Error(secret);
  error.name = "PasswordException";
  expect(exportFailure(error, "pdf_decode").reason).toBe("encrypted_pdf");
  expect(exportFailure(error, "font_embed").reason).toBe("font_embed");
  expect(
    exportFailure(new Error("PasswordException"), "pdf_decode").reason,
  ).toBe("pdf_decode");
});
it("records cancellation as one informational terminal event", async () => {
  const controller = new AbortController();
  mocks.engine.mockImplementation(() => {
    controller.abort();
    throw new Error(secret);
  });
  await expect(
    exportTranslatedPDF(doc, controller.signal, vi.fn()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "info",
      event: "pdf.translation_export.cancelled",
      detail: expect.stringContaining("reasonCode=user_cancelled"),
    }),
  );
  expect(
    mocks.log.mock.calls.filter(([e]) => e.event.endsWith("failed")),
  ).toHaveLength(0);
  expect(mocks.download).not.toHaveBeenCalled();
});
it("keeps successful downloads free of failure diagnostics", async () => {
  await exportTranslatedPDF(doc, new AbortController().signal, vi.fn());
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      event: "pdf.translation_export.download_requested",
    }),
  );
  expect(
    mocks.log.mock.calls.filter(([e]) => e.event.endsWith("failed")),
  ).toHaveLength(0);
});

it("keeps menu export progress visible after the menu closes and reports the downloaded result", async () => {
  mocks.engine.mockImplementation(
    async (_load, _source, _blocks, _translations, _fonts, options) => {
      options.onProgress({ phase: "pages", done: 1, total: 3 });
      return {
        bytes: new Uint8Array(),
        pages: 3,
        translated: 2,
        issues: [{ page: 2, reason: "overflow" }],
      };
    },
  );
  await exportTranslatedPDFWithToast(doc);
  expect(mocks.toast.loading).toHaveBeenCalledWith(
    "正在排版 2 / 3 页",
    expect.objectContaining({
      id: "export",
      action: expect.objectContaining({ label: "取消" }),
    }),
  );
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(mocks.toast.success).toHaveBeenCalledWith("已开始下载译文 PDF", {
    id: "export",
    description: "3 页，2 个译文段落，1 处保留原文",
    action: undefined,
  });
});
it("reports a menu export failure without an unhandled rejection or download", async () => {
  mocks.engine.mockRejectedValue(new Error("没有已完成译文"));
  await exportTranslatedPDFWithToast(doc);
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.toast.error).toHaveBeenCalledWith("没有已完成译文", {
    id: "export",
    action: undefined,
  });
  expect(mocks.toast.success).not.toHaveBeenCalled();
});
it("cancels a menu export before it can download and reports cancellation without a failure toast", async () => {
  mocks.engine.mockImplementation(async () => {
    const options = mocks.toast.loading.mock.calls[0][1];
    options!.action!.onClick();
    return { bytes: new Uint8Array(), pages: 1, translated: 1, issues: [] };
  });
  await exportTranslatedPDFWithToast(doc);
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.toast.info).toHaveBeenCalledWith("已取消导出", {
    id: "export",
    action: undefined,
  });
  expect(mocks.toast.error).not.toHaveBeenCalled();
});
