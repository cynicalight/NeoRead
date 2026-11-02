import {
  exportFailure,
  PDFExportError,
  type PDFExportFailure,
} from "./pdf-export-error";
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFPage,
} from "pdf-lib";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import { pdfFontAscent } from "../../../../packages/neoread-core/src/pdf-text";
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import { fitText, overlaps, validRect, type Rect } from "./pdf-layout";
import { splitLegacyCaptions } from "./pdf-captions";
import { matchesSource, preservedLabels } from "./pdf-content";
import { preparePDFText } from "./pdf-math";
import { embedExportFonts, type FontBytes } from "./pdf-fonts";

import type {
  ExportIssue,
  PDFExportProgress,
  TranslatedPDF,
} from "./pdf-export-model";
export type ExportCanvas = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  dispose(): void;
};
export type ExportOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: PDFExportProgress) => void;
  createCanvas?: (width: number, height: number) => ExportCanvas;
};

function browserCanvas(width: number, height: number): ExportCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 PDF 导出画布");
  return {
    canvas,
    context,
    dispose: () => {
      canvas.width = canvas.height = 0;
    },
  };
}

function pageBox(block: PDFBlock, width: number, height: number): Rect {
  const b = block.bounds;
  return {
    x: b.x * width,
    y: b.y * height,
    width: b.width * width,
    height: b.height * height,
  };
}

function contains(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Original link hotspots no longer identify the same words after reflow. */
function removeCoveredLinks(page: PDFPage, source: PDFPageProxy, mask: Rect) {
  const annotations = page.node.Annots();
  if (!annotations) return;
  const viewport = source.getViewport({ scale: 1 });
  for (let index = annotations.size() - 1; index >= 0; index--) {
    const annotation = page.doc.context.lookup(annotations.get(index));
    if (
      !(annotation instanceof PDFDict) ||
      annotation.get(PDFName.of("Subtype"))?.toString() !== "/Link"
    )
      continue;
    const rect = annotation.lookup(PDFName.of("Rect"));
    if (!(rect instanceof PDFArray) || rect.size() !== 4) continue;
    const values = rect
      .asArray()
      .map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN));
    if (!values.every(Number.isFinite)) continue;
    const a = viewport.convertToViewportPoint(values[0], values[1]);
    const b = viewport.convertToViewportPoint(values[2], values[3]);
    if (
      overlaps(mask, {
        x: Math.min(a[0], b[0]),
        y: Math.min(a[1], b[1]),
        width: Math.abs(a[0] - b[0]),
        height: Math.abs(a[1] - b[1]),
      })
    )
      annotations.remove(index);
  }
}

/** Only neutral white paper is covered. Keep tinted backgrounds/figures unchanged. */
function isWhitePaper(
  context: CanvasRenderingContext2D,
  box: Rect,
  scale: number,
): boolean {
  const x = Math.max(0, Math.floor(box.x * scale));
  const y = Math.max(0, Math.floor(box.y * scale));
  const width = Math.max(1, Math.ceil((box.x + box.width) * scale) - x);
  const height = Math.max(1, Math.ceil((box.y + box.height) * scale) - y);
  const { data } = context.getImageData(x, y, width, height);
  let white = 0,
    colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    const high = Math.max(data[i], data[i + 1], data[i + 2]);
    if (low >= 248) white++;
    if (high - low > 16) colored++;
  }
  const pixels = data.length / 4;
  return white / pixels > 0.65 && colored / pixels < 0.005;
}

async function textSpans(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [a, b, c, d, e, f] = item.transform;
    const origin = viewport.convertToViewportPoint(e, f);
    const advance = Math.hypot(a, b);
    if (!advance) return [];
    const end = viewport.convertToViewportPoint(
      e + (item.width * a) / advance,
      f + (item.width * b) / advance,
    );
    const top = viewport.convertToViewportPoint(e + c, f + d);
    const up = [top[0] - origin[0], top[1] - origin[1]];
    const fontSize = Math.hypot(...up);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    // Four corners are required: treating vertical margin text as horizontal
    // invents a page-wide box that falsely overlaps otherwise safe paragraphs.
    const corners = [origin, end].flatMap((point) =>
      [ascent, ascent - 1].map((factor) => [
        point[0] + up[0] * factor,
        point[1] + up[1] * factor,
      ]),
    );
    const xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    return [
      {
        box: {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        },
        text: item.str,
        size: fontSize,
        horizontal:
          end[0] > origin[0] &&
          Math.abs(end[1] - origin[1]) < 0.01 &&
          up[1] < 0 &&
          Math.abs(up[0]) < 0.01,
      },
    ];
  });
}

/**
 * Write an independent copy. Original vectors, page boxes and navigation survive.
 * Covering is visual replacement, not redaction: original text remains in PDF data.
 * A block is committed only after source, geometry, glyph and fit checks all pass.
 */
export async function translatedPDF(
  getDocument: (parameters: DocumentInitParameters) => PDFDocumentLoadingTask,
  source: DocumentInitParameters,
  blocks: PDFBlock[],
  translations: TranslationBlock[],
  fontBytes: FontBytes,
  { signal, onProgress, createCanvas = browserCanvas }: ExportOptions = {},
): Promise<TranslatedPDF> {
  signal?.throwIfAborted();
  onProgress?.({ phase: "preparing", done: 0, total: 0 });
  let task: PDFDocumentLoadingTask;
  try {
    task = getDocument(source);
  } catch (error) {
    throw exportFailure(error, "pdf_decode");
  }
  let failureReason: PDFExportFailure = "pdf_decode";
  let failed = false;
  // Destroy also interrupts network loading and a pending PDF.js render.
  const abort = () => {
    void task.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const input = await task.promise;
    signal?.throwIfAborted();
    const output = await PDFDocument.load(await input.getData());
    failureReason = "font_embed";
    const fonts = await embedExportFonts(output, fontBytes);
    failureReason = "layout";
    const byId = new Map(translations.map((t) => [t.blockId, t]));
    const byPage = new Map<number, PDFBlock[]>();
    const issues: ExportIssue[] = [];
    for (const block of blocks) {
      if (
        !Number.isInteger(block.page) ||
        block.page < 1 ||
        block.page > input.numPages
      ) {
        issues.push({ page: block.page, blockId: block.id, reason: "bounds" });
        continue;
      }
      const pageBlocks = byPage.get(block.page) ?? [];
      pageBlocks.push(block);
      byPage.set(block.page, pageBlocks);
    }
    let translated = 0;
    for (let number = 1; number <= input.numPages; number++) {
      signal?.throwIfAborted();
      onProgress?.({ phase: "pages", done: number - 1, total: input.numPages });
      let pageBlocks = byPage.get(number) ?? [];
      if (!pageBlocks.length) {
        issues.push({ page: number, reason: "unparsed" });
        continue;
      }
      const page = await input.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const { width, height } = viewport;
      if (
        ![width, height].every(
          (n) => Number.isFinite(n) && n > 0 && n <= 20_000,
        )
      )
        throw new PDFExportError(
          "page_dimensions",
          new Error("PDF 页面尺寸超出导出范围"),
        );
      const spans = await textSpans(page);
      const recovered = splitLegacyCaptions(pageBlocks, spans, width, height);
      pageBlocks = recovered.blocks;
      issues.push(
        ...recovered.unresolved.map((blockId) => ({
          page: number,
          blockId,
          reason: "source" as const,
        })),
      );
      const boxes = pageBlocks.map((b) => pageBox(b, width, height));
      const pdfPage = output.getPage(number - 1);
      let surface: ExportCanvas | undefined;
      const scale = Math.min(1.5, Math.sqrt(4_000_000 / (width * height)));
      try {
        for (let index = 0; index < pageBlocks.length; index++) {
          signal?.throwIfAborted();
          const block = pageBlocks[index];
          if (
            block.image ||
            preservedLabels.has(block.label) ||
            !block.text.trim()
          )
            continue;
          const issue = (reason: ExportIssue["reason"]) =>
            issues.push({ page: number, blockId: block.id, reason });
          const translation = byId.get(block.id);
          if (
            !translation ||
            translation.status !== "complete" ||
            !translation.sentences.length
          ) {
            issue("untranslated");
            continue;
          }
          if (!(await matchesSource(block, translation))) {
            issue("stale");
            continue;
          }
          const content = preparePDFText(
            translation.sentences.map((s) => s.target.trim()).join(" "),
            fonts,
          );
          if (!content) {
            issue("structure");
            continue;
          }
          const box = boxes[index];
          if (
            !validRect(box) ||
            !contains({ x: 0, y: 0, width, height }, box)
          ) {
            issue("bounds");
            continue;
          }
          const localSpans = spans.filter((s) => overlaps(s.box, box));
          // Layout detection and font metrics can disagree slightly, especially
          // for mathematical scripts. Grow the erasure to the measured glyphs,
          // but reject large mismatches and any newly covered neighboring content.
          if (
            !localSpans.length ||
            localSpans.some(
              (s) =>
                !s.horizontal ||
                !contains(box, s.box, Math.min(4, s.size * 0.35)),
            )
          ) {
            issue("source");
            continue;
          }
          const left = Math.max(
            0,
            Math.min(box.x, ...localSpans.map((s) => s.box.x)) - 0.75,
          );
          const top = Math.max(
            0,
            Math.min(box.y, ...localSpans.map((s) => s.box.y)) - 0.75,
          );
          const maskRight = Math.min(
            width,
            Math.max(
              box.x + box.width,
              ...localSpans.map((s) => s.box.x + s.box.width),
            ) + 0.75,
          );
          const bottom = Math.min(
            height,
            Math.max(
              box.y + box.height,
              ...localSpans.map((s) => s.box.y + s.box.height),
            ) + 0.75,
          );
          const mask = {
            x: left,
            y: top,
            width: maskRight - left,
            height: bottom - top,
          };
          if (
            boxes.some((other, j) => j !== index && overlaps(mask, other)) ||
            spans.some((s) => !localSpans.includes(s) && overlaps(mask, s.box))
          ) {
            issue("overlap");
            continue;
          }
          if (!content.supported) {
            issue("font");
            continue;
          }
          // Many short superscripts must not outweigh the main text when
          // choosing the paragraph size. Weight the median by horizontal extent.
          const orderedSpans = [...localSpans].sort((a, b) => a.size - b.size);
          let remainingWidth =
            orderedSpans.reduce((sum, s) => sum + s.box.width, 0) / 2;
          const preferredSize = orderedSpans.find(
            (s) => (remainingWidth -= s.box.width) <= 0,
          )!.size;
          const layout = fitText(
            content.text,
            box,
            preferredSize,
            content.measure,
            content.ascent + content.descent,
          );
          if (!layout) {
            issue("overflow");
            continue;
          }
          if (!surface) {
            surface = createCanvas(
              Math.ceil(width * scale),
              Math.ceil(height * scale),
            );
            await page.render({
              canvas: surface.canvas,
              canvasContext: surface.context,
              viewport: page.getViewport({ scale }),
              background: "#ffffff",
            }).promise;
          }
          if (!isWhitePaper(surface.context, mask, scale)) {
            issue("background");
            continue;
          }
          signal?.throwIfAborted();
          // Transform displayed bottom-left coordinates back to PDF user space.
          // This handles /Rotate, crop-box offsets and /UserUnit without special cases.
          const origin = viewport.convertToPdfPoint(0, height);
          const right = viewport.convertToPdfPoint(1, height);
          const up = viewport.convertToPdfPoint(0, height - 1);
          pdfPage.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(
              right[0] - origin[0],
              right[1] - origin[1],
              up[0] - origin[0],
              up[1] - origin[1],
              origin[0],
              origin[1],
            ),
          );
          pdfPage.drawRectangle({
            x: mask.x,
            y: height - mask.y - mask.height,
            width: mask.width,
            height: mask.height,
            color: rgb(1, 1, 1),
          });
          layout.lines.forEach((line, lineIndex) => {
            const centered =
              (block.label === "doc_title" ||
                block.label === "paragraph_title") &&
              Math.abs(box.x + box.width / 2 - width / 2) < width * 0.05;
            const x =
              box.x +
              (centered
                ? (box.width - content.measure(line, layout.size)) / 2
                : 0);
            content.draw(
              pdfPage,
              line,
              x,
              height -
                box.y -
                layout.size * content.ascent -
                lineIndex * layout.lineHeight,
              layout.size,
            );
          });
          pdfPage.pushOperators(popGraphicsState());
          removeCoveredLinks(pdfPage, page, mask);
          translated++;
        }
      } finally {
        surface?.dispose();
        page.cleanup();
      }
      // Allow cancellation and progress to paint between pages.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    if (!translated)
      throw new PDFExportError(
        "no_translated_blocks",
        new Error(
          "当前没有能安全排入原版面的译文，请完成翻译后重试，或导出 Markdown。",
        ),
      );
    onProgress?.({
      phase: "saving",
      done: input.numPages,
      total: input.numPages,
    });
    failureReason = "save";
    output.setProducer("NeoRead");
    const bytes = await output.save({ objectsPerTick: 30 });
    signal?.throwIfAborted();
    return { bytes, translated, pages: input.numPages, issues };
  } catch (error) {
    failed = true;
    throw exportFailure(error, failureReason);
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await task.destroy();
    } catch (error) {
      // A cleanup failure must not hide the original operation's failure.
      if (!failed && !signal?.aborted) throw exportFailure(error, "cleanup");
    }
  }
}
