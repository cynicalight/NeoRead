import type {
  PDFBlock,
  PDFLocation,
  ReaderSelection,
  TranslationBlock,
  TranslationSentence,
} from "@neoread/core";
import { sentenceAnchor } from "@neoread/core";
import { selectionContext } from "../readers/selection-context";

/**
 * Sentence parts shown for a reflowed source paragraph. A completed
 * translation supplies the extracted text of each sentence, so part `i`
 * hovers with translated sentence `i` and quotes still match the PDF text. Otherwise the extracted text
 * is split exactly as sentence hover splits untranslated source text.
 */
export function reflowSourceParts(
  text: string,
  translation?: TranslationBlock,
): string[] {
  const sentences =
    translation?.status === "complete" && translation.sentences.length
      ? translation.sentences
      : undefined;
  if (!sentences) return segmentSentences(text).map((s) => s.source);
  const parts = sentences.map(sentenceAnchor);
  return parts.map((part, i) => {
    const next = parts[i + 1] ?? "";
    return part + (next && needsSpace(part, next) ? " " : "");
  });
}

/** The same untranslated split used by sentence hover. */
export function segmentSentences(text: string): TranslationSentence[] {
  if (typeof Intl === "undefined" || !("Segmenter" in Intl))
    return text ? [{ source: text, target: "" }] : [];
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text),
    (s) => ({ source: s.segment, target: "" }),
  );
}

// Western sentences need a space between them; CJK text and text that already
// carries whitespace does not.
const cjk = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;
function needsSpace(left: string, right: string) {
  const last = left.at(-1) ?? "",
    first = right[0] ?? "";
  return (
    !/\s/.test(last) && !/\s/.test(first) && !cjk.test(last) && !cjk.test(first)
  );
}

function sourceElement(host: HTMLElement, blockId: string) {
  return Array.from(
    host.querySelectorAll<HTMLElement>("[data-reflow-source]"),
  ).find((n) => n.dataset.reflowSource === blockId);
}

/** Whether `host` renders this block's source as reflowed text. */
export function hasReflowSource(host: HTMLElement, blockId: string) {
  return !!sourceElement(host, blockId);
}

/**
 * Text-node ranges of one reflowed source sentence, or of the whole paragraph
 * when `index` is omitted.
 */
export function reflowSourceRanges(
  host: HTMLElement,
  blockId: string,
  index?: number,
): Range[] {
  const element = sourceElement(host, blockId);
  const root =
    index === undefined
      ? element
      : element?.querySelector(`[data-source-sentence="${index}"]`);
  if (!root) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    ranges.push(range);
  }
  return ranges;
}

/**
 * A selection of reflowed PDF source text. Each touched paragraph becomes a
 * source anchor, which the PDF view also resolves in its text layer.
 */
export function reflowSourceSelection(
  host: HTMLElement,
  range: Range,
  blocks: PDFBlock[],
): ReaderSelection | undefined {
  const anchors: NonNullable<PDFLocation["sourceAnchors"]> = [];
  for (const node of host.querySelectorAll<HTMLElement>(
    "[data-reflow-source]",
  )) {
    if (!range.intersectsNode(node)) continue;
    const block = blocks.find((b) => b.id === node.dataset.reflowSource);
    if (!block) continue;
    const clipped = document.createRange();
    clipped.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
      clipped.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
      clipped.setEnd(range.endContainer, range.endOffset);
    const source = clipped.toString().trim();
    if (source)
      anchors.push({
        blockId: block.id,
        source,
        page: block.page,
        bounds: block.bounds,
      });
  }
  const text = range.toString().trim();
  if (!anchors.length || !text) return;
  const rect = range.getBoundingClientRect();
  return {
    context: selectionContext(range, host),
    text,
    anchor: {
      x: (rect.left + rect.right) / 2,
      top: rect.top,
      bottom: rect.bottom,
    },
    location: {
      type: "pdf",
      page: anchors[0].page,
      quote: anchors.map((a) => a.source).join(" "),
      sourceAnchors: anchors,
    },
  };
}
