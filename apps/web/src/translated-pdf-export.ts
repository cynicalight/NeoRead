import {
  exportOperation,
  exportFailure,
  exportFailureDetail,
  PDFExportError,
} from "./translation/pdf-export-error";
import type { Document } from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { downloadBlob, fileTitle } from "./download";
import { reportDiagnostic } from "./diagnostics";
import type {
  PDFExportProgress,
  TranslatedPDF,
} from "./translation/pdf-export-model";

export async function exportTranslatedPDF(
  doc: Document,
  signal: AbortSignal,
  onProgress: (progress: PDFExportProgress) => void,
): Promise<Omit<TranslatedPDF, "bytes">> {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  let phase = "snapshot";
  const event = (result: string, detail = "") =>
    reportDiagnostic({
      level: result === "failed" ? "error" : "info",
      event: `pdf.translation_export.${result}`,
      requestId,
      durationMs: Math.round(performance.now() - started),
      detail: `phase=${phase}${detail ? ` ${detail}` : ""}`,
    });
  const font = (path: string) =>
    exportOperation("font_load", async () => {
      const response = await fetch(path, { signal });
      if (!response.ok)
        throw new Error("PDF 导出字体加载失败，请重新打开应用后重试。");
      return new Uint8Array(await response.arrayBuffer());
    });
  event("start");
  onProgress({ phase: "preparing", done: 0, total: 0 });
  try {
    if (doc.type !== "pdf")
      throw new PDFExportError(
        "unsupported_document",
        new Error("译文 PDF 导出仅适用于 PDF 文档"),
      );
    signal.throwIfAborted();
    const [blocks, translations, cjk, latin, pdfjs, engine] = await Promise.all(
      [
        exportOperation("snapshot", () => api.blocks(doc.id, signal)),
        exportOperation("snapshot", () => api.translations(doc.id, signal)),
        font("/pdf-assets/export-fonts/NotoSansSC-Regular.ttf"),
        font("/pdf-assets/standard_fonts/LiberationSans-Regular.ttf"),
        exportOperation("module_load", () => import("pdfjs-dist")),
        exportOperation(
          "module_load",
          () => import("./translation/pdf-export"),
        ),
      ],
    );
    signal.throwIfAborted();
    phase = "layout";
    event("stage");
    pdfjs.GlobalWorkerOptions.workerSrc ||= workerURL;
    const result = await engine.translatedPDF(
      pdfjs.getDocument,
      {
        url: publicationURL(doc.id, "original.pdf"),
        cMapUrl: "/pdf-assets/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdf-assets/standard_fonts/",
        wasmUrl: "/pdf-assets/wasm/",
      },
      blocks,
      translations,
      { cjk, latin },
      {
        signal,
        onProgress: (progress) => {
          if (progress.phase === "saving") {
            phase = "saving";
            event("stage");
          }
          onProgress(progress);
        },
      },
    );
    signal.throwIfAborted();
    phase = "download";
    downloadBlob(
      new Blob([result.bytes as Uint8Array<ArrayBuffer>], {
        type: "application/pdf",
      }),
      `${fileTitle(doc.title)}-译文.pdf`,
    );
    // Browser download initiation is observable; disk completion is not.
    event(
      "download_requested",
      `pages=${result.pages} translated=${result.translated} preserved=${result.issues.length}`,
    );
    const { bytes: _bytes, ...summary } = result;
    return summary;
  } catch (error) {
    event(
      signal.aborted ? "cancelled" : "failed",
      signal.aborted
        ? "reasonCode=user_cancelled"
        : exportFailureDetail(
            exportFailure(
              error,
              phase === "download"
                ? "download"
                : phase === "layout"
                  ? "layout"
                  : phase === "saving"
                    ? "save"
                    : "unrecognized",
            ),
          ),
    );
    if (signal.aborted) throw new DOMException("已取消导出", "AbortError");
    throw error;
  }
}
