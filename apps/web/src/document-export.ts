import type {
  Annotation,
  Document,
  Message,
  PDFBlock,
  EPUBReadingBlock,
} from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import { saveExportBlob, exportCancelled, fileTitle } from "./download";
import { notesMarkdown } from "./notes-export";
import { reportDiagnostic } from "./diagnostics";

export const annotationExportKinds = {
  note: "批注",
  underline: "划线",
  highlight: "高亮",
  question: "问题",
} as const;
export type AnnotationExportKind = keyof typeof annotationExportKinds;
export type ExportFormat = "markdown" | "pdf";
export type ExportTarget = "annotations" | "original" | "translation";

export function annotationMarkdown(
  doc: Document,
  annotations: Annotation[],
  messages: Message[],
  kinds: AnnotationExportKind[],
  link?: (annotation: Annotation) => string,
) {
  return notesMarkdown(
    doc,
    {
      annotations: annotations.filter((a) =>
        kinds.includes(a.kind as AnnotationExportKind),
      ),
      messages,
      paperNote: "",
    },
    ["notes", "highlights", "questions"],
    link,
  );
}

export function originalMarkdown(
  doc: Document,
  blocks: (PDFBlock | EPUBReadingBlock)[],
) {
  const out = [`# ${doc.title.replace(/[\r\n]/g, " ")}`];
  let page = 0;
  let count = 0;
  for (const block of blocks) {
    if (["header", "footer", "number"].includes(block.label)) continue;
    if (!block.text.trim() && !block.image) continue;
    if ("page" in block && block.page !== page) {
      page = block.page;
      out.push(`## 第 ${page} 页`);
    }
    if (block.image) out.push("> [图片]");
    if (block.text.trim()) {
      const heading = ["doc_title", "paragraph_title"].includes(block.label)
        ? "### "
        : "";
      out.push(heading + block.text.trim());
    }
    count++;
  }
  if (!count) throw new Error("正文尚未解析，暂时无法导出 Markdown");
  return out.join("\n\n") + "\n";
}

export async function exportMarkdownFile(
  markdown: string,
  filename: string,
  format: ExportFormat,
  signal: AbortSignal,
): Promise<"download" | "print"> {
  signal.throwIfAborted();
  if (format === "markdown") {
    await saveExportBlob(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      `${filename}.md`,
      signal,
    );
    return "download";
  }
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const report = (result: string) =>
    reportDiagnostic({
      level: result === "failed" ? "error" : "info",
      event: `markdown.pdf_export.${result}`,
      requestId,
      durationMs: Math.round(performance.now() - started),
    });
  report("start");
  try {
    const engine = await import("./markdown-pdf");
    signal.throwIfAborted();
    const html = engine.markdownPrintHTML(markdown, filename);
    const desktop = window.neoreadDesktop;
    if (!desktop?.markdownPDF) {
      await engine.printMarkdownInBrowser(html, signal, filename);
      report("print_dialog_closed");
      return "print";
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
    await saveExportBlob(
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      `${filename}.pdf`,
      signal,
    );
    report(
      window.neoreadDesktop?.saveExportFile ? "saved" : "download_requested",
    );
    return "download";
  } catch (error) {
    report(exportCancelled(error, signal) ? "cancelled" : "failed");
    throw error;
  }
}

export async function exportOriginal(
  doc: Document,
  format: ExportFormat,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (doc.type === "pdf" && format === "pdf") {
    const response = await fetch(publicationURL(doc.id, "original.pdf"), {
      signal,
    });
    if (!response.ok) throw new Error("原文读取失败，请重试");
    const blob = await response.blob();
    signal.throwIfAborted();
    await saveExportBlob(blob, `${fileTitle(doc.title)}-原文.pdf`, signal);
    return "download" as const;
  }
  const blocks =
    doc.type === "pdf"
      ? await api.blocks(doc.id, signal)
      : await api.epubBlocks(doc.id, signal);
  signal.throwIfAborted();
  return exportMarkdownFile(
    originalMarkdown(doc, blocks),
    `${fileTitle(doc.title)}-原文`,
    format,
    signal,
  );
}
