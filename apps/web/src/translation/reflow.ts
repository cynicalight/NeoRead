import type {
  PDFBlock,
  PDFLocation,
  ReaderSelection,
  TranslationBlock,
  TranslationSentence,
} from "@neoread/core";
import { sentenceAnchor } from "@neoread/core";
import { selectionContext } from "../readers/selection-context";
import { searchRanges } from "./search-ranges";
import { texText } from "../chat/tex-text";

/** One reflowed source sentence. */
export interface ReflowPart {
  /** Extracted text, which quotes and PDF locations use. */
  text: string;
  /** The model's sentence with inline math restored as KaTeX, shown instead. */
  display?: string;
}
// Unescaped inline KaTeX, as the translation prompt asks for.
const katex = /(?<!\\)\$[^$]*[^\s$\\][^$]*(?<!\\)\$/;
/**
 * Sentence parts shown for a reflowed source paragraph. A completed
 * translation supplies the extracted text of each sentence, so part `i`
 * hovers with translated sentence `i` and quotes still match the PDF text.
 * A sentence whose model text restores inline math shows that text instead.
 * Otherwise the extracted text is split exactly as sentence hover splits
 * untranslated source text.
 */
export function reflowSourceParts(
  text: string,
  translation?: TranslationBlock,
): ReflowPart[] {
  const sentences =
    translation?.status === "complete" && translation.sentences.length
      ? translation.sentences
      : undefined;
  if (!sentences)
    return segmentSentences(text).map((s) => ({ text: s.source }));
  const parts = sentences.map(sentenceAnchor);
  return parts.map((part, i) => {
    const next = parts[i + 1] ?? "";
    const space = next && needsSpace(part, next) ? " " : "";
    const source = sentences[i].source;
    return katex.test(source) && !katex.test(part)
      ? { text: part + space, display: source + space }
      : { text: part + space };
  });
}

/**
 * A source paragraph with the inline formulas its translation restored, as
 * TeX; the same text reflow shows, whether or not reflow is on.
 */
export function restoredSource(text: string, translation?: TranslationBlock) {
  return reflowSourceParts(text, translation)
    .map((part) => part.display ?? part.text)
    .join("")
    .trim();
}

/**
 * A reflowed paragraph as copied: its restored source, a blank line, then its
 * translation.
 */
export function reflowBlockText(text: string, translation?: TranslationBlock) {
  const source = restoredSource(text, translation);
  const target =
    translation?.status === "complete"
      ? translation.sentences
          .map((s) => s.target)
          .reduce(
            (all, next) =>
              all + (all && needsSpace(all, next) ? " " : "") + next,
            "",
          )
          .trim()
      : "";
  return target ? `${source}\n\n${target}` : source;
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
    const source = selectedSource(node, range).trim();
    if (source)
      anchors.push({
        blockId: block.id,
        source,
        page: block.page,
        bounds: block.bounds,
      });
  }
  // Read text keeps restored formulas as TeX; anchors keep extracted text.
  const text = texText(range).trim();
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

function clip(node: Node, range: Range) {
  const clipped = document.createRange();
  clipped.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
    clipped.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
    clipped.setEnd(range.endContainer, range.endOffset);
  return clipped.toString();
}
const sentenceNodes = (node: HTMLElement) =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-source-sentence]"));
/**
 * Selected extracted text of one reflowed paragraph. Rendered KaTeX cannot be
 * mapped back character by character, so a touched restored sentence
 * contributes its whole extracted text.
 */
function selectedSource(node: HTMLElement, range: Range) {
  const sentences = sentenceNodes(node);
  if (!sentences.some((s) => s.dataset.anchor)) return clip(node, range);
  return sentences
    .filter((s) => range.intersectsNode(s))
    .map((s) => s.dataset.anchor ?? clip(s, range))
    .join("");
}

/**
 * Ranges of a saved quote in reflowed text. A quote that crosses a restored
 * formula is not literal text there, so it marks the sentences it covers.
 */
export function reflowQuoteRanges(
  host: HTMLElement,
  blockId: string,
  quote: string,
): Range[] {
  const found = searchRanges(reflowSourceRanges(host, blockId), quote);
  const element = sourceElement(host, blockId);
  if (found.length || !element?.querySelector("[data-anchor]")) return found;
  const compact = (text: string) => text.replace(/\s/g, "").toLowerCase();
  const needle = compact(quote);
  if (!needle) return [];
  return sentenceNodes(element).flatMap((s, i) => {
    const text = compact(s.dataset.anchor ?? s.textContent ?? "");
    return text && (needle.includes(text) || text.includes(needle))
      ? reflowSourceRanges(host, blockId, i)
      : [];
  });
}
