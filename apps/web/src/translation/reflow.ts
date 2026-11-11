import type { TranslationBlock, TranslationSentence } from "@neoread/core";
import { sentenceAnchor } from "@neoread/core";
import { lcsMatches } from "../text-align";

/** One reflowed source sentence. */
export interface ReflowPart {
  /** Extracted text, which quotes and PDF locations use. */
  text: string;
  /** The model's repaired sentence, shown instead; it maps back to `text`. */
  display?: string;
}
// Unescaped inline KaTeX, as the translation prompt asks for.
const katex = /(?<!\\)\$[^$]*[^\s$\\][^$]*(?<!\\)\$/;
// Share of extracted characters a repair must keep to be shown as source.
const repairSimilarity = 0.9;
// Longer sentences are not compared; they keep their extracted text.
const repairCells = 1 << 20;
const repairs = new WeakMap<TranslationSentence, boolean>();
/**
 * Whether a sentence shows the model's repaired text. Restored inline math is
 * always shown; other repairs only when they keep nearly every extracted
 * character, so a rewrite never reads as the original.
 */
function showsRepair(sentence: TranslationSentence) {
  const { source, anchor } = sentence;
  if (!anchor || anchor === source) return false;
  if (katex.test(source) && !katex.test(anchor)) return true;
  let shown = repairs.get(sentence);
  if (shown === undefined) {
    const a = repairChars(source),
      b = repairChars(anchor);
    const longest = Math.max(a.length, b.length);
    shown =
      longest > 0 &&
      a.length * b.length <= repairCells &&
      lcsMatches(a, b).filter((j) => j !== undefined).length >=
        longest * repairSimilarity;
    repairs.set(sentence, shown);
  }
  return shown;
}
// Compatibility forms fold math italic letters into plain ones.
const repairChars = (text: string) =>
  Array.from(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\u00ad]/g, ""),
  );
/**
 * Sentence parts shown for a reflowed source paragraph. A completed
 * translation supplies the extracted text of each sentence, so part `i`
 * hovers with translated sentence `i` and quotes still match the PDF text.
 * A sentence the model repaired shows that text instead, when the repair is
 * close to the extracted text. Otherwise the extracted text is split exactly
 * as sentence hover splits untranslated source text.
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
    return showsRepair(sentences[i])
      ? { text: part + space, display: sentences[i].source + space }
      : { text: part + space };
  });
}

/**
 * A source paragraph with the repairs its translation made, inline formulas
 * as TeX; the same text reflow shows, whether or not reflow is on.
 */
export function restoredSource(text: string, translation?: TranslationBlock) {
  return reflowSourceParts(text, translation)
    .map((part) => part.display ?? part.text)
    .join("")
    .trim();
}

/**
 * A reflowed paragraph as copied: its repaired source, a blank line, then its
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
export function needsSpace(left: string, right: string) {
  const last = left.at(-1) ?? "",
    first = right[0] ?? "";
  return (
    !/\s/.test(last) && !/\s/.test(first) && !cjk.test(last) && !cjk.test(first)
  );
}

/** The element holding a block's reflowed source text, if rendered. */
export function reflowSourceElement(host: HTMLElement, blockId: string) {
  return Array.from(
    host.querySelectorAll<HTMLElement>("[data-reflow-source]"),
  ).find((n) => n.dataset.reflowSource === blockId);
}

/** Whether `host` renders this block's source as reflowed text. */
export function hasReflowSource(host: HTMLElement, blockId: string) {
  return !!reflowSourceElement(host, blockId);
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
  const element = reflowSourceElement(host, blockId);
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

/** The sentence elements of a reflowed source paragraph. */
export const sentenceNodes = (node: HTMLElement) =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-source-sentence]"));
/** Text as compared across extraction differences: no spaces, lower case. */
export const compact = (text: string) => text.replace(/\s/g, "").toLowerCase();
/** A restored sentence stands for its extracted text; a plain one shows it. */
export const sentenceText = (s: HTMLElement) =>
  s.dataset.anchor ?? s.textContent ?? "";
