import type { PDFBlock } from "@reader/core";
import { figureReferences, figureTarget } from "./figure-references";

/** Keep PDF.js spans and their transforms intact; only wrap text inside them. */
export class PDFFigureLinks {
  constructor(
    private host: HTMLElement,
    private blocks: () => PDFBlock[],
    private focus: (block: PDFBlock) => void,
  ) {
    host.addEventListener("click", this.click, true);
  }
  private click = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (this.host.ownerDocument.getSelection()?.toString()) return;
    const element = event.target instanceof Element ? event.target : null;
    let anchor = element?.closest<HTMLAnchorElement>(
      "a[data-figure-reference]",
    );
    // PDF annotations sit above the text layer. Match the whole native link
    // rectangle, so padding clicks and keyboard activation also replace PDF.js.
    const native = element?.closest<HTMLAnchorElement>(
      ".annotationLayer a.internalLink, .annotationLayer [data-internal-link] a",
    );
    if (!anchor && native) {
      const nativeRects = Array.from(native.getClientRects());
      const candidates = Array.from(
        native
          .closest(".page")
          ?.querySelectorAll<HTMLAnchorElement>("a[data-figure-reference]") ??
          [],
      ).filter((link) =>
        Array.from(link.getClientRects()).some((r) =>
          nativeRects.some(
            (n) =>
              Math.min(r.right, n.right) > Math.max(r.left, n.left) &&
              Math.min(r.bottom, n.bottom) > Math.max(r.top, n.top),
          ),
        ),
      );
      // A large annotation can span multiple references; don't guess its target.
      if (
        new Set(candidates.map((link) => link.dataset.figureReference)).size ===
        1
      )
        anchor = candidates[0];
    }
    if (!anchor) return;
    const block = figureTarget(this.blocks(), anchor.dataset.figureReference!);
    if (!block) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.focus(block);
  };
  repaint() {
    for (const layer of this.host.querySelectorAll<HTMLElement>(".textLayer")) {
      for (const link of layer.querySelectorAll("a[data-figure-reference]")) {
        const parent = link.parentNode!;
        link.replaceWith(...link.childNodes);
        parent.normalize();
      }
      const nodes: { node: Text; start: number; end: number }[] = [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let text = "";
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (node.parentElement?.closest("a")) continue;
        nodes.push({
          node,
          start: text.length,
          end: text.length + node.length,
        });
        text += node.data + " ";
      }
      // Reverse order keeps the offsets of earlier references stable.
      for (const reference of figureReferences(text).reverse()) {
        if (!figureTarget(this.blocks(), reference.label)) continue;
        const end = reference.index + reference.text.length;
        for (const entry of nodes) {
          const startOffset = Math.max(0, reference.index - entry.start);
          const endOffset = Math.min(entry.end, end) - entry.start;
          if (startOffset >= endOffset) continue;
          const range = document.createRange();
          range.setStart(entry.node, startOffset);
          range.setEnd(entry.node, endOffset);
          const link = document.createElement("a");
          link.href = `#reader-figure-${reference.label}`;
          link.dataset.figureReference = reference.label;
          link.setAttribute("aria-label", `跳转到 ${reference.text}`);
          // The canvas supplies visible glyphs. Preserve the invisible text
          // layer, but retain the browser's keyboard focus outline.
          link.style.color = "inherit";
          link.style.textDecoration = "none";
          link.style.cursor = "pointer";
          range.surroundContents(link);
        }
      }
    }
  }
  destroy() {
    this.host.removeEventListener("click", this.click, true);
  }
}
