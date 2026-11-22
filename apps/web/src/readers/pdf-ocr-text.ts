import type { PDFBlock, PDFOCRPreviewPage } from "@neoread/core";

type Line = NonNullable<PDFBlock["ocrLines"]>[number];

function usableLine(line: Line) {
  return !!line.text.trim() && line.bounds.width > 0 && line.bounds.height > 0;
}

function sameLines(left: Line[], right: Line[]) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((line, i) => {
        const other = right[i];
        return (
          line.text === other.text &&
          line.bounds.x === other.bounds.x &&
          line.bounds.y === other.bounds.y &&
          line.bounds.width === other.bounds.width &&
          line.bounds.height === other.bounds.height
        );
      }))
  );
}

/** The unrotated page size in PDF points, as PDF.js lays out a text layer. */
export interface PDFPageSize {
  width: number;
  height: number;
}

const fontFamily = "sans-serif";
let measure: CanvasRenderingContext2D | null = null;
/** Advance width per unit of font size. */
function textWidth(text: string) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return 0;
  measure.font = `100px ${fontFamily}`;
  return measure.measureText(text).width / 100;
}

/**
 * Converts a rectangle on the displayed page into the text layer's unrotated
 * frame. PDF.js rotates the whole layer with `data-main-rotation`; each line
 * turns back by the same angle so it reads horizontally on screen again.
 */
function place(bounds: Line["bounds"], rotation: number, page: PDFPageSize) {
  const turned = rotation % 180 !== 0;
  const [left, top] =
    rotation === 90
      ? [bounds.y, 1 - bounds.x]
      : rotation === 180
        ? [1 - bounds.x, 1 - bounds.y]
        : rotation === 270
          ? [1 - bounds.y, bounds.x]
          : [bounds.x, bounds.y];
  return {
    left,
    top,
    width: bounds.width * (turned ? page.height : page.width),
    height: bounds.height * (turned ? page.width : page.height),
  };
}

/**
 * Adds recognized scan lines to PDF.js's own text layer as transparent spans,
 * so selection, copying and highlights treat them like native PDF text. Each
 * span covers its recognized line box at every zoom level: the size uses the
 * same CSS variables as PDF.js text, and the text is stretched to the box width.
 */
export class PDFOCRText {
  private pages = new Map<number, Line[]>();
  private previewPages = new Map<number, Line[]>();
  private pending = new Set<HTMLElement>();
  private painted = new WeakMap<
    HTMLElement,
    { lines: Line[]; rotation: number } & PDFPageSize
  >();
  constructor(
    private host: HTMLElement,
    private pageSize: (page: number) => PDFPageSize | undefined,
  ) {}
  setBlocks(blocks: PDFBlock[]) {
    // DOM order is selection order: follow parsed reading order, keeping each
    // block's lines together instead of interleaving columns by height.
    const pages = new Map<number, Line[]>();
    for (const block of blocks) {
      for (const line of block.ocrLines ?? []) {
        if (!usableLine(line)) continue;
        const page = pages.get(block.page) ?? [];
        page.push(line);
        pages.set(block.page, page);
      }
    }
    if (!pages.size && !this.pages.size) return;
    this.pages = pages;
    this.repaintMountedLayers();
  }

  setPreview(pages: PDFOCRPreviewPage[] | null) {
    if (pages) {
      for (const { page, lines } of pages) {
        const usable = lines.filter(usableLine);
        if (!usable.length) continue;
        this.previewPages.set(page, usable);
        this.paint(page);
      }
    } else if (this.previewPages.size) {
      this.previewPages.clear();
      // Terminal transitions must not leave superseded text selectable.
      this.repaintMountedLayers(false);
    }
  }

  flushSelection() {
    for (const layer of this.pending) {
      if (this.host.contains(layer)) this.paintLayer(layer);
      else this.pending.delete(layer);
    }
  }

  private repaintMountedLayers(preserveSelection = true) {
    for (const layer of this.host.querySelectorAll<HTMLElement>(
      ".page[data-page-number] .textLayer",
    ))
      this.paintLayer(layer, preserveSelection);
  }
  /** Called when PDF.js has rendered or rescaled one page's text layer. */
  paint(page: number) {
    if (!this.previewPages.has(page) && !this.pages.has(page)) return;
    const layer = this.host.querySelector<HTMLElement>(
      `.page[data-page-number="${page}"] .textLayer`,
    );
    if (layer) this.paintLayer(layer);
  }
  private paintLayer(layer: HTMLElement, preserveSelection = true) {
    const page = Number(layer.closest<HTMLElement>(".page")!.dataset.pageNumber);
    const lines = this.previewPages.get(page) ?? this.pages.get(page);
    const previous = this.painted.get(layer);
    if (!lines && !previous) return;
    // PDF.js appends this marker once its own text is in place.
    const end = layer.querySelector(".endOfContent");
    if (!end) {
      this.pending.delete(layer);
      return;
    }
    const size = lines && this.pageSize(page);
    const rotation =
      (((Number(layer.dataset.mainRotation) || 0) % 360) + 360) % 360;
    if (
      size &&
      lines &&
      previous &&
      previous.rotation === rotation &&
      previous.width === size.width &&
      previous.height === size.height &&
      sameLines(previous.lines, lines) &&
      layer.querySelector("[data-ocr-line]")
    ) {
      // Keep identical text nodes on refetch and on final publication.
      previous.lines = lines;
      this.pending.delete(layer);
      return;
    }
    const old = layer.querySelectorAll("[data-ocr-line]");
    const selection = preserveSelection && layer.ownerDocument.getSelection();
    if (
      old.length &&
      selection &&
      selection.rangeCount &&
      !selection.isCollapsed
    ) {
      const range = selection.getRangeAt(0);
      for (const node of old) {
        if (!range.intersectsNode(node)) continue;
        this.pending.add(layer);
        return;
      }
    }
    this.pending.delete(layer);
    for (const node of old) node.remove();
    if (!size || !lines) {
      this.painted.delete(layer);
      return;
    }
    this.painted.set(layer, { lines, rotation, ...size });
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const box = place(line.bounds, rotation, size);
      const span = document.createElement("span");
      span.dataset.ocrLine = "";
      span.setAttribute("role", "presentation");
      span.textContent = line.text;
      span.style.left = `${box.left * 100}%`;
      span.style.top = `${box.top * 100}%`;
      span.style.fontFamily = fontFamily;
      span.style.setProperty("--font-height", `${box.height}px`);
      const natural = textWidth(line.text) * box.height;
      if (natural > 0)
        span.style.setProperty("--scale-x", `${box.width / natural}`);
      if (rotation) span.style.setProperty("--rotate", `${-rotation}deg`);
      // Like PDF.js line ends: copied text and sentence selection break here.
      const br = document.createElement("br");
      br.dataset.ocrLine = "";
      br.setAttribute("role", "presentation");
      fragment.append(span, br);
    }
    // Selection may temporarily move the marker; otherwise keep it last.
    layer.insertBefore(fragment, end.parentElement === layer ? end : null);
  }
}
