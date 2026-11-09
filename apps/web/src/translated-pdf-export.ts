import {
  exportOperation,
  exportFailure,
  exportFailureDetail,
} from "./translation/pdf-export-error";
import type { Document } from "@neoread/core";
import { toast } from "sonner";
import { api } from "@neoread/api";
import { downloadBlob, fileTitle } from "./download";
import { reportDiagnostic } from "./diagnostics";
export type PDFExportProgress = { phase: "preparing" | "saving" };
export type TranslatedPDFResult = { delivery: "download" | "print" };

export async function exportTranslatedPDF(
  doc: Document,
  signal: AbortSignal,
  onProgress: (progress: PDFExportProgress) => void,
): Promise<TranslatedPDFResult> {
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
  event("start");
  onProgress({ phase: "preparing" });
  try {
    signal.throwIfAborted();
    const [blob, engine] = await Promise.all([
      exportOperation("snapshot", () =>
        api.exportTranslation(doc.id, "markdown", signal),
      ),
      exportOperation("module_load", () => import("./markdown-pdf")),
    ]);
    signal.throwIfAborted();
    phase = "layout";
    event("stage");
    const html = engine.markdownPrintHTML(
      await blob.text(),
      `${fileTitle(doc.title)}-译文`,
    );
    signal.throwIfAborted();
    phase = "saving";
    event("stage");
    onProgress({ phase: "saving" });
    const desktop = window.neoreadDesktop;
    if (!desktop?.markdownPDF) {
      await engine.printMarkdownInBrowser(
        html,
        signal,
        `${fileTitle(doc.title)}-译文`,
      );
      event("print_dialog_closed");
      return { delivery: "print" };
    }
    const cancel = () => {
      void desktop.cancelMarkdownPDF?.(requestId).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    let bytes: Uint8Array;
    try {
      bytes = await desktop.markdownPDF(requestId, html);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    signal.throwIfAborted();
    phase = "download";
    downloadBlob(
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      `${fileTitle(doc.title)}-译文.pdf`,
    );
    event("download_requested");
    return { delivery: "download" };
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

/** The library menu closes before export finishes; keep progress and cancellation available. */
export async function exportTranslatedPDFWithToast(doc: Document) {
  const controller = new AbortController();
  const action = { label: "取消", onClick: () => controller.abort() };
  const id = toast.loading("正在读取译文…", { action });
  try {
    const result = await exportTranslatedPDF(
      doc,
      controller.signal,
      (progress) => {
        if (controller.signal.aborted) return;
        toast.loading(
          progress.phase === "preparing" ? "正在读取译文…" : "正在生成 PDF…",
          { id, action },
        );
      },
    );
    if (result.delivery === "download")
      toast.success("已开始下载译文 PDF", { id, action: undefined });
    else toast.info("打印窗口已关闭", { id, action: undefined });
  } catch (error) {
    if (controller.signal.aborted)
      toast.info("已取消导出", { id, action: undefined });
    else
      toast.error(
        error instanceof Error ? error.message : "译文 PDF 导出失败，请重试",
        { id, action: undefined },
      );
  }
}

export async function exportTranslatedMarkdownWithToast(doc: Document) {
  const controller = new AbortController();
  const id = toast.loading("正在读取译文…", {
    action: { label: "取消", onClick: () => controller.abort() },
  });
  try {
    const blob = await api.exportTranslation(
      doc.id,
      "markdown",
      controller.signal,
    );
    controller.signal.throwIfAborted();
    downloadBlob(blob, `${fileTitle(doc.title)}-译文.md`);
    toast.success("已开始下载译文 Markdown", { id, action: undefined });
  } catch (error) {
    if (controller.signal.aborted)
      toast.info("已取消导出", { id, action: undefined });
    else
      toast.error(
        error instanceof Error ? error.message : "译文导出失败，请重试",
        { id, action: undefined },
      );
  }
}
