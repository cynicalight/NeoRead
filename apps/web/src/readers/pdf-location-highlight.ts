import type { PDFLocation } from "@neoread/core";

/** Transient navigation feedback, independent of selection and parsed blocks. */
export class PDFLocationHighlight {
  private target?: PDFLocation;
  private fallback?: PDFLocation["rects"];
  private timer?: ReturnType<typeof setTimeout>;
  private layer?: HTMLDivElement;
  constructor(private host: HTMLElement) {}
  show(location: PDFLocation, quote = "", fallback?: PDFLocation["rects"]) {
    this.clear();
    this.target = { ...location, quote: location.quote || quote };
    this.fallback = fallback;
    this.paint();
  }
  paint = () => {
    this.layer?.remove();
    this.layer = undefined;
    const target = this.target;
    if (!target) return;
    const page = this.host.querySelector<HTMLElement>(
      `.page[data-page-number="${target.page}"]`,
    );
    if (!page) return;
    const bounds = page.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    let rects = target.rects?.length
      ? target.rects
      : this.quoteRects(page, target);
    // Search feedback must never turn a missing word into a paragraph selection.
    if (!rects.length && !target.quoteContext) rects = this.fallback ?? [];
    if (!rects.length) return;
    const layer = document.createElement("div");
    layer.className = "neoread-location-highlight";
    layer.setAttribute("aria-hidden", "true");
    for (const rect of rects) {
      const mark = document.createElement("div");
      Object.assign(mark.style, {
        position: "absolute",
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
      });
      layer.append(mark);
    }
    page.append(layer);
    this.layer = layer;
    // Start expiry only once there is visible geometry, not while waiting for PDF.js.
    this.timer ??= setTimeout(() => this.clear(), 3000);
  };
  private quoteRects(page: HTMLElement, target: PDFLocation) {
    const textLayer = page.querySelector(".textLayer");
    const normalize = (value: string) =>
      value.toLowerCase().replace(/[\s\u00ad]/g, "");
    const needle = normalize(target.quote ?? "");
    if (!textLayer || !needle) return [];
    const positions: { node: Text; offset: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent ?? "";
      for (let i = 0; i < value.length; i++) {
        const char = normalize(value[i]);
        text += char;
        for (let n = 0; n < char.length; n++)
          positions.push({ node: node as Text, offset: i });
      }
    }
    const bounds = page.getBoundingClientRect();
    const candidates: {
      rects: { x: number; y: number; width: number; height: number }[];
      score: number;
    }[] = [];
    const context = target.quoteContext;
    const paragraph = context ? normalize(context.text) : "";
    const offset = context
      ? normalize(context.text.slice(0, context.start)).length
      : 0;
    for (
      let at = text.indexOf(needle);
      at >= 0;
      at = text.indexOf(needle, at + 1)
    ) {
      // Prefer the exact occurrence. OCR repairs elsewhere in the paragraph
      // must not prevent matching a word still present in the PDF text layer.
      let score = 0;
      if (context) {
        if (
          at >= offset &&
          paragraph &&
          text.slice(at - offset, at - offset + paragraph.length) === paragraph
        )
          score = paragraph.length + 1;
        else {
          for (let i = 1; i <= offset && i <= at; i++) {
            if (paragraph[offset - i] !== text[at - i]) break;
            score++;
          }
          for (
            let i = needle.length;
            offset + i < paragraph.length && at + i < text.length;
            i++
          ) {
            if (paragraph[offset + i] !== text[at + i]) break;
            score++;
          }
        }
      }
      const rects = [];
      // Separate text-node ranges avoid giant boxes across columns or <br> elements.
      for (let start = at; start < at + needle.length;) {
        let end = start + 1;
        while (
          end < at + needle.length &&
          positions[end].node === positions[start].node
        )
          end++;
        const range = document.createRange();
        range.setStart(positions[start].node, positions[start].offset);
        range.setEnd(positions[end - 1].node, positions[end - 1].offset + 1);
        for (const rect of Array.from(range.getClientRects())) {
          if (!rect.width || !rect.height) continue;
          rects.push({
            x: (rect.left - bounds.left) / bounds.width,
            y: (rect.top - bounds.top) / bounds.height,
            width: rect.width / bounds.width,
            height: rect.height / bounds.height,
          });
        }
        start = end;
      }
      if (
        context &&
        this.fallback?.length &&
        !rects.some((rect) =>
          this.fallback!.some(
            (block) =>
              rect.x < block.x + block.width &&
              rect.x + rect.width > block.x &&
              rect.y < block.y + block.height &&
              rect.y + rect.height > block.y,
          ),
        )
      )
        continue;
      if (rects.length) candidates.push({ rects, score });
    }
    if (target.x !== undefined || target.y !== undefined) {
      const distance = (rect: { x: number; y: number }) =>
        Math.abs(rect.x - (target.x ?? rect.x)) +
        Math.abs(rect.y - (target.y ?? rect.y));
      candidates.sort(
        (a, b) =>
          b.score - a.score || distance(a.rects[0]) - distance(b.rects[0]),
      );
    } else {
      candidates.sort((a, b) => b.score - a.score);
    }
    return candidates[0]?.rects ?? [];
  }
  clear = () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.target = undefined;
    this.fallback = undefined;
    this.layer?.remove();
    this.layer = undefined;
  };
}
