import type {
  Annotation,
  EPUBReadingBlock,
  PDFBlock,
  ReaderAdapter,
} from "@neoread/core";
import { overlap } from "../readers/pdf-reading";
import { textRange } from "./annotations";
import { compact, hasReflowSource, reflowSourceElement } from "./reflow";
import { reflowMarkRanges, reflowQuoteRanges } from "./reflow-marks";

/**
 * Ranges of a saved PDF source mark in the source text shown now. A mark made
 * in reflowed text carries paragraph anchors, one made in the PDF text layer
 * only page rectangles; either may be shown in the other view.
 */
export function pdfSourceMarkRanges(
  host: HTMLElement,
  annotation: Annotation,
  blocks: (PDFBlock | EPUBReadingBlock)[],
  engine: ReaderAdapter,
): Range[] {
  const location = annotation.location;
  if (
    location.type !== "pdf" ||
    annotation.kind === "bookmark" ||
    (location.translation && !location.sourceAnchors?.length)
  )
    return [];
  const passages = (location.sourceAnchors ?? []).flatMap((anchor) => {
    const candidates = blocks.filter(
      (block) =>
        "page" in block &&
        block.page === anchor.page &&
        compact(block.text).includes(compact(anchor.source)),
    );
    const block =
      candidates.find((block) => block.id === anchor.blockId) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    return block
      ? [{ blockId: block.id, sources: [anchor.source], anchor }]
      : [];
  });
  if (!passages.length) {
    // A text-layer mark: find its quote in the reflowed paragraphs under the
    // saved rectangles. The text layer itself is drawn by the PDF adapter.
    if (!location.quote?.trim()) return [];
    const covered = blocks.flatMap((block) =>
      "page" in block &&
      block.page === location.page &&
      hasReflowSource(host, block.id) &&
      (!location.rects?.length ||
        location.rects.some((r) => overlap(r, block.bounds) > 0))
        ? [block.id]
        : [],
    );
    return reflowMarkRanges(host, covered, location.quote);
  }
  const reflowed = passages.filter((p) => hasReflowSource(host, p.blockId));
  // A reflow mark shown in the PDF view is found in the text layer.
  if (!reflowed.length) return engine.sentenceRanges?.(passages) ?? [];
  return reflowed.flatMap(({ blockId, anchor }) => {
    const node = reflowSourceElement(host, blockId);
    // Saved offsets hold only while the paragraph still renders the same text.
    const exact =
      node &&
      anchor.text === node.textContent &&
      anchor.start !== undefined &&
      anchor.end !== undefined
        ? textRange(node, anchor.start, anchor.end)
        : undefined;
    return exact ? [exact] : reflowQuoteRanges(host, blockId, anchor.source);
  });
}
