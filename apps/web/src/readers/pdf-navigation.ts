import { animatePDFScroll } from "./pdf-scroll";
import { sentenceTextRanges } from "./pdf-sentence-matching";
import * as pdfjs from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { isPDFPageDecoration, sentenceAnchor } from "@reader/core";
import type {
  PDFBlock,
  PDFReadingAnchor,
  ReaderEvents,
  PDFLocation,
  PDFPassage,
  PDFSentenceLink,
  TranslationBlock,
} from "@reader/core";
import { overlap, type Box } from "./pdf-reading";

export class PDFReadingNavigation {
  private moving = false;
  private disposed = false;
  private frame = 0;
  private operation = 0;
  private focus: PDFPassage[] = [];
  private linkedRanges: Range[] = [];
  private anchorBlocksSource?: PDFBlock[];
  private anchorBlocks: PDFBlock[] = [];
  constructor(
    private host: HTMLElement,
    private viewer: PDFViewer,
    private page: (n: number) => Promise<pdfjs.PDFPageProxy>,
    private blocks: () => PDFBlock[],
    private events: ReaderEvents,
    private onFocus: (blockId: string | null) => void = () => {},
  ) {
    host.addEventListener("pointerdown", this.interrupt);
    host.addEventListener("scroll", this.scrolled, { passive: true });
    host.addEventListener("wheel", this.interrupt, { passive: true });
  }
  private interrupt = () => {
    this.operation++;
    this.moving = false;
    this.onFocus(null);
  };
  private async moveTo(left: number, top: number, operation: number) {
    this.moving = true;
    try {
      await animatePDFScroll(
        this.host,
        left,
        top,
        () => this.disposed || operation !== this.operation,
        () => {},
      );
    } finally {
      if (operation === this.operation) {
        this.moving = false;
        this.scrolled();
      }
    }
  }
  async goTo(page: number, point?: { x: number; y: number }) {
    const operation = ++this.operation;
    const node = this.pageNode(page);
    if (!node || this.disposed || operation !== this.operation) return false;
    this.onFocus(null);
    const r = node.getBoundingClientRect(),
      v = this.host.getBoundingClientRect();
    await this.moveTo(
      this.host.scrollLeft + r.left - v.left + (point?.x ?? 0) * r.width,
      this.host.scrollTop + r.top - v.top + (point?.y ?? 0) * r.height - 24,
      operation,
    );
    return !this.disposed && operation === this.operation;
  }
  private pageNode(n: number) {
    return this.viewer.getPageView(n - 1)?.div as HTMLElement | undefined;
  }
  private scrolled = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (this.disposed || this.moving) return;
      const anchor = this.anchor();
      if (anchor) this.events.readingAnchor?.(anchor);
    });
  };
  anchor(): PDFReadingAnchor | undefined {
    const viewport = this.host.getBoundingClientRect(),
      y = viewport.top + viewport.height * 0.5,
      x = viewport.left + viewport.width / 2;
    let best: PDFBlock | undefined,
      distance = Infinity,
      fraction = 0;
    const sourceBlocks = this.blocks();
    if (sourceBlocks !== this.anchorBlocksSource) {
      this.anchorBlocksSource = sourceBlocks;
      this.anchorBlocks = sourceBlocks.filter(
        (b) => !isPDFPageDecoration(b) && (b.image || b.text.trim()),
      );
    }
    // A PDF page contains many reading blocks, but its layout rectangle is the
    // same for all of them. Read it once per visible page rather than once per
    // block; repeated geometry reads here were stalling the other pane during
    // synchronized scrolling.
    const pageRects = new Map<number, DOMRect | null>();
    for (const b of this.anchorBlocks) {
      let r = pageRects.get(b.page);
      if (r === undefined) {
        r = this.pageNode(b.page)?.getBoundingClientRect() ?? null;
        pageRects.set(b.page, r);
      }
      if (!r) continue;
      if (r.bottom < viewport.top || r.top > viewport.bottom) continue;
      const bx = r.left + b.bounds.x * r.width,
        by = r.top + b.bounds.y * r.height,
        bw = b.bounds.width * r.width,
        bh = b.bounds.height * r.height;
      const d =
        Math.max(bx - x, x - bx - bw, 0) * 2 + Math.max(by - y, y - by - bh, 0);
      if (d < distance) {
        distance = d;
        best = b;
        fraction = Math.max(0, Math.min(1, (y - by) / (bh || 1)));
      }
    }
    return best ? { blockId: best.id, fraction } : undefined;
  }
  stop() {
    this.interrupt();
    if (!this.host.classList.contains("pdf-block-reading")) return;
    const page = this.pageNode(this.viewer.currentPageNumber);
    const before = page?.getBoundingClientRect();
    this.host.classList.remove("pdf-block-reading");
    if (page && before) {
      const after = page.getBoundingClientRect();
      this.host.scrollLeft += after.left - before.left;
      this.host.scrollTop += after.top - before.top;
    }
  }
  private readableBlocks() {
    // The parser supplies reading order within each page, including figures.
    return this.blocks()
      .filter((b) => !isPDFPageDecoration(b) && (b.image || b.text.trim()))
      .sort((a, b) => a.page - b.page);
  }
  cancelMotion() {
    this.interrupt();
  }
  private updateInsets() {
    this.host.style.setProperty(
      "--reading-inset-x",
      `${this.host.clientWidth / 2}px`,
    );
    this.host.style.setProperty(
      "--reading-inset-y",
      `${this.host.clientHeight / 2}px`,
    );
    this.host.classList.add("pdf-block-reading");
  }
  async focusBlock(id: string, layout: "source" | "parallel" = "source") {
    const block = this.readableBlocks().find((b) => b.id === id);
    if (!block || this.disposed) return false;
    const operation = ++this.operation;
    this.moving = true;
    try {
      const page =
        layout === "parallel" ? await this.page(block.page) : undefined;
      if (this.disposed || operation !== this.operation) return false;
      const node = this.pageNode(block.page);
      if (!node || !this.host.clientWidth || !this.host.clientHeight)
        return false;
      // PDF viewport dimensions are points; PDF.js displays them at 96 / 72 CSS pixels.
      // Read the current panel width after any asynchronous page load, on every click.
      const scale = page
        ? Math.min(
            2,
            Math.max(
              0.1,
              (this.host.clientWidth - 32) /
                (page.getViewport({ scale: 1 }).width *
                  (96 / 72) *
                  block.bounds.width),
            ),
          )
        : 1.5;
      const before = node.getBoundingClientRect(),
        beforeView = this.host.getBoundingClientRect(),
        beforeX =
          before.left -
          beforeView.left +
          (block.bounds.x + block.bounds.width / 2) * before.width,
        beforeY =
          before.top - beforeView.top + block.bounds.y * before.height;
      this.onFocus(block.id);
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      // Scaling every animation frame repeatedly cancels and restarts PDF.js
      // page renders. Apply the final scale once, then animate only scrolling.
      this.updateInsets();
      if (Math.abs(this.viewer.currentScale - scale) > 0.0001) {
        if (this.viewer.updateScale)
          this.viewer.updateScale({
            scaleFactor: scale / this.viewer.currentScale,
            drawingDelay: 100,
          });
        else this.viewer.currentScaleValue = String(scale);
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (this.disposed || operation !== this.operation) return false;
      let r = node.getBoundingClientRect(),
        v = this.host.getBoundingClientRect();
      // Keep the focused text at its original screen position while the final
      // scale is applied, then animate from there to the centered position.
      this.host.scrollLeft +=
        r.left -
        v.left +
        (block.bounds.x + block.bounds.width / 2) * r.width -
        beforeX;
      this.host.scrollTop +=
        r.top -
        v.top +
        block.bounds.y * r.height -
        beforeY;
      r = node.getBoundingClientRect();
      v = this.host.getBoundingClientRect();
      const left =
        this.host.scrollLeft +
        r.left -
        v.left +
        (block.bounds.x + block.bounds.width / 2) * r.width -
        this.host.clientWidth / 2;
      const top =
        this.host.scrollTop +
        r.top -
        v.top +
        block.bounds.y * r.height -
        Math.max(0, (this.host.clientHeight - block.bounds.height * r.height) / 2);
      if (reduced) {
        this.host.scrollLeft = left;
        this.host.scrollTop = top;
      } else {
        await this.moveTo(left, top, operation);
      }
      if (this.disposed || operation !== this.operation) return false;
      const anchor = this.anchor();
      if (anchor) this.events.readingAnchor?.(anchor);
      return true;
    } finally {
      if (operation === this.operation) {
        this.moving = false;
        this.onFocus(null);
      }
    }
  }
  async follow(anchor: PDFReadingAnchor, smooth = true) {
    const block = this.blocks().find((b) => b.id === anchor.blockId);
    if (!block || isPDFPageDecoration(block)) return;
    const operation = ++this.operation;
    const node = this.pageNode(block.page);
    if (!node) return;
    const r = node.getBoundingClientRect(),
      v = this.host.getBoundingClientRect();
    let left = this.host.scrollLeft;
    const x = r.left + block.bounds.x * r.width;
    if (x > v.right || x + block.bounds.width * r.width < v.left)
      left += x - v.left - 16;
    const top =
      this.host.scrollTop +
      r.top -
      v.top +
      (block.bounds.y + anchor.fraction * block.bounds.height) * r.height -
      this.host.clientHeight * 0.5;
    if (!smooth) {
      // Live pane synchronization runs once per animation frame. Restarting a
      // 240 ms animation for every new anchor makes the target pane perpetually
      // chase the source. Apply the latest position directly instead.
      this.moving = false;
      this.host.scrollLeft = left;
      this.host.scrollTop = top;
      this.scrolled();
      return;
    }
    await this.moveTo(left, top, operation);
  }
  focusSentences(blockId: string, sources: string[], scroll = false) {
    return this.focusPassages(
      sources.length ? [{ blockId, sources }] : [],
      scroll,
    );
  }
  async focusPassages(passages: PDFPassage[], scroll = false) {
    if (this.disposed) return;
    this.focus = passages;
    this.paintFocus();
    const first = passages[0];
    if (!scroll || !first) return;
    const block = this.blocks().find((b) => b.id === first.blockId);
    if (!block) return;
    const node = this.pageNode(block.page);
    const top = node
      ? this.domSentenceBoxes(node, block, first.sources, first.sourceOffset)[0]
          ?.y
      : undefined;
    // An unrendered sentence can still scroll to its paragraph. It must never
    // use that paragraph's bounds as the visible sentence highlight.
    await this.follow({
      blockId: block.id,
      fraction: Math.max(
        0,
        Math.min(
          1,
          ((top ?? block.bounds.y) - block.bounds.y) /
            (block.bounds.height || 1),
        ),
      ),
    });
    if (!this.disposed && this.focus === passages) this.paintFocus();
  }
  sentenceRanges(passages: PDFPassage[]): Range[] {
    if (this.disposed) return [];
    return passages.flatMap((passage) => {
      const block = this.blocks().find((b) => b.id === passage.blockId);
      const node = block && this.pageNode(block.page);
      if (!block || !node) return [];
      return this.domSentenceRanges(
        node,
        block,
        passage.sources,
        passage.sourceOffset,
      ).flatMap((range) => {
        // A cross-node Range includes PDF.js <br> nodes, whose highlight can
        // extend to the text-layer edge. Restrict every fragment to one text run.
        const walker = document.createTreeWalker(
          node.querySelector(".textLayer")!,
          NodeFilter.SHOW_TEXT,
        );
        const fragments: Range[] = [];
        let text: Node | null;
        while ((text = walker.nextNode())) {
          if (!range.intersectsNode(text)) continue;
          const start = text === range.startContainer ? range.startOffset : 0;
          const end =
            text === range.endContainer
              ? range.endOffset
              : (text.textContent?.length ?? 0);
          if (end <= start) continue;
          const fragment = document.createRange();
          fragment.setStart(text, start);
          fragment.setEnd(text, end);
          fragments.push(fragment);
        }
        return fragments;
      });
    });
  }
  private clearLinkedRanges() {
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    const highlight = registry?.get("reader-linked-sentences");
    if (highlight) {
      for (const range of this.linkedRanges) highlight.delete(range);
      if (!highlight.size) registry!.delete("reader-linked-sentences");
    }
    this.linkedRanges = [];
  }
  private paintFocus() {
    this.clearLinkedRanges();
    if (
      this.disposed ||
      typeof Highlight === "undefined" ||
      typeof CSS === "undefined" ||
      !CSS.highlights
    )
      return;
    for (const passage of this.focus) {
      const block = this.blocks().find((b) => b.id === passage.blockId);
      if (!block || !passage.sources.length) continue;
      const node = this.pageNode(block.page);
      if (!node) continue;
      this.linkedRanges.push(
        ...this.domSentenceRanges(
          node,
          block,
          passage.sources,
          passage.sourceOffset,
        ),
      );
    }
    if (!this.linkedRanges.length) return;
    const highlight =
      CSS.highlights.get("reader-linked-sentences") ?? new Highlight();
    for (const range of this.linkedRanges) highlight.add(range);
    CSS.highlights.set("reader-linked-sentences", highlight);
  }
  async matchSentences(
    location: PDFLocation,
    translations: TranslationBlock[],
  ): Promise<PDFSentenceLink[]> {
    const selection = location.rects ?? [],
      result: PDFSentenceLink[] = [];
    for (const block of this.blocks()) {
      if (isPDFPageDecoration(block)) continue;
      if (
        block.page !== location.page ||
        !selection.some((r) => overlap(r, block.bounds) > 0)
      )
        continue;
      const translation = translations.find(
        (t) => t.blockId === block.id && t.status === "complete",
      );
      if (!translation) continue;
      const node = this.pageNode(block.page);
      let prefix = "",
        reliable = !!node;
      const indexes: number[] = [];
      for (const [i, sentence] of translation.sentences.entries()) {
        const boxes = node
          ? this.domSentenceBoxes(
              node,
              block,
              [sentenceAnchor(sentence)],
              prefix.replace(/[\s\u00ad]/g, "").length,
            )
          : [];
        prefix += sentenceAnchor(sentence);
        if (!boxes.length) {
          reliable = false;
          break;
        }
        if (boxes.some((b) => selection.some((r) => overlap(b, r) > 0)))
          indexes.push(i);
      }
      if (reliable && indexes.length) {
        result.push({ blockId: block.id, sentenceIndexes: indexes });
      } else {
        const normalize = (text: string) =>
          text.toLowerCase().replace(/[\s\u00ad]/g, "");
        const needle = normalize(location.quote ?? "");
        const joined = translation.sentences
          .map((s) => normalize(sentenceAnchor(s)))
          .join("");
        const start = needle ? joined.indexOf(needle) : -1;
        // Missing geometry must not associate the entire paragraph or a repeated phrase.
        if (start < 0 || joined.indexOf(needle, start + 1) >= 0) continue;
        let offset = 0;
        const matches = translation.sentences.flatMap((sentence, i) => {
          const end = offset + normalize(sentenceAnchor(sentence)).length;
          const overlaps = offset < start + needle.length && end > start;
          offset = end;
          return overlaps ? [i] : [];
        });
        if (matches.length)
          result.push({ blockId: block.id, sentenceIndexes: matches });
      }
    }
    return result;
  }
  private domSentenceBoxes(
    node: HTMLElement,
    block: PDFBlock,
    sources: string[],
    startOffset = 0,
  ): Box[] {
    const page = node.getBoundingClientRect();
    return this.domSentenceRanges(node, block, sources, startOffset).flatMap(
      (range) =>
        Array.from(range.getClientRects())
          .filter((r) => r.width && r.height)
          .map((r) => ({
            x: (r.left - page.left) / page.width,
            y: (r.top - page.top) / page.height,
            width: r.width / page.width,
            height: r.height / page.height,
          })),
    );
  }
  private domSentenceRanges(
    node: HTMLElement,
    block: PDFBlock,
    sources: string[],
    startOffset = 0,
  ): Range[] {
    const page = node.getBoundingClientRect();
    if (!page.width) return [];
    const nodes: Array<{ node: Text; offset: number; group: number }> = [],
      chars: string[] = [];
    const walker = document.createTreeWalker(
      node.querySelector(".textLayer") ?? document.createElement("div"),
      NodeFilter.SHOW_TEXT,
    );
    let text: Node | null,
      group = 0;
    while ((text = walker.nextNode())) {
      const parent = text.parentElement,
        r = parent?.getBoundingClientRect();
      if (!r) {
        group++;
        continue;
      }
      const b = {
        x: (r.left - page.left) / page.width,
        y: (r.top - page.top) / page.height,
        width: r.width / page.width,
        height: r.height / page.height,
      };
      // Parser bounds can cut through a PDF.js line. Include one line of
      // vertical context; sentence text, not this box, determines the highlight.
      const region = {
        ...block.bounds,
        y: block.bounds.y - b.height,
        height: block.bounds.height + 2 * b.height,
      };
      if (overlap(b, region) / (b.width * b.height || 1) < 0.5) {
        group++;
        continue;
      }
      for (let i = 0; i < (text.textContent?.length ?? 0); i++) {
        const c = text.textContent![i];
        if (/[\s\u00ad]/.test(c)) continue;
        chars.push(c.toLowerCase());
        nodes.push({ node: text as Text, offset: i, group });
      }
    }
    const joined = chars.join(""),
      ranges: Range[] = [];
    const normalize = (value: string) =>
      value.toLowerCase().replace(/[\s\u00ad]/g, "");
    for (const { start: i, end: cursor } of sentenceTextRanges(
      joined,
      normalize(block.text),
      sources.map(normalize),
      startOffset,
    )) {
      // PDF DOM order can interleave columns. Never let a Range bridge text
      // nodes that were excluded from this paragraph during matching.
      for (let start = i; start < cursor;) {
        let end = start + 1;
        while (end < cursor && nodes[end].group === nodes[start].group) end++;
        const a = nodes[start],
          z = nodes[end - 1];
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(z.node, z.offset + 1);
        ranges.push(range);
        start = end;
      }
    }
    return ranges;
  }
  repaint() {
    this.paintFocus();
  }
  destroy() {
    this.stop();
    this.disposed = true;
    this.clearLinkedRanges();
    cancelAnimationFrame(this.frame);
    this.host.removeEventListener("pointerdown", this.interrupt);
    this.host.removeEventListener("scroll", this.scrolled);
    this.host.removeEventListener("wheel", this.interrupt);
  }
}
