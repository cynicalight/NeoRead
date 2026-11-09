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
const compact = (text: string) => text.replace(/\s/g, "").toLowerCase();

/**
 * One rendered piece of a restored sentence, a character or a whole formula,
 * with the span [from, to) of extracted-text characters (spaces removed) it
 * stands for. An unmatched piece has an empty span at its position.
 */
interface Unit {
  node: Node;
  offset: number;
  formula?: Element;
  from: number;
  to: number;
}
/**
 * Aligns a restored sentence's rendered text with its extracted text: plain
 * characters by longest common subsequence, and each formula to the extracted
 * characters left between its matched neighbours.
 */
function sentenceUnits(sentence: HTMLElement): Unit[] {
  const anchor = compact(sentence.dataset.anchor ?? "");
  const units: Unit[] = [];
  const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const formula = node.parentElement?.closest("[data-tex]");
    if (formula) {
      if (units.at(-1)?.formula !== formula)
        units.push({ node: formula, offset: 0, formula, from: 0, to: 0 });
      continue;
    }
    const text = node.textContent ?? "";
    for (let k = 0; k < text.length; k++)
      if (!/\s/.test(text[k])) units.push({ node, offset: k, from: 0, to: 0 });
  }
  const chars = units.flatMap((u) =>
    u.formula ? [] : [u.node.textContent![u.offset].toLowerCase()],
  );
  const matched = lcsMatches(chars, anchor);
  let c = 0;
  const at = units.map((u) => (u.formula ? undefined : matched[c++]));
  units.forEach((u, k) => {
    const own = at[k];
    if (own !== undefined) {
      u.from = own;
      u.to = own + 1;
      return;
    }
    // Between the matched neighbours: a formula covers that gap, an unmatched
    // character sits at its start.
    let before = -1,
      after = anchor.length;
    for (let j = k - 1; j >= 0; j--)
      if (at[j] !== undefined) {
        before = at[j]!;
        break;
      }
    for (let j = k + 1; j < units.length; j++)
      if (at[j] !== undefined) {
        after = at[j]!;
        break;
      }
    u.from = before + 1;
    u.to = u.formula ? Math.max(u.from, after) : u.from;
  });
  return units;
}

// For each item of `a`, the index in `b` it pairs with in a longest common
// subsequence, or undefined.
function lcsMatches(a: string[], b: string) {
  const n = a.length,
    m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: (number | undefined)[] = new Array(n);
  for (let i = 0, j = 0; i < n && j < m;)
    if (a[i] === b[j]) out[i++] = j++;
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  return out;
}

// Whether a unit lies in the extracted span [s, e). A formula overlapping it
// counts whole; an empty span counts when the text on both sides does.
const unitIn = (u: Unit, s: number, e: number) =>
  u.to > u.from ? u.from < e && u.to > s : s < u.from && u.from < e;

/** Ranges of a restored sentence that stand for its extracted span [s, e). */
function restoredRanges(sentence: HTMLElement, s: number, e: number) {
  const ranges: Range[] = [];
  let run: Range | undefined;
  for (const u of sentenceUnits(sentence)) {
    if (!unitIn(u, s, e)) {
      run = undefined;
      continue;
    }
    if (u.formula) {
      const range = document.createRange();
      range.selectNode(u.formula);
      ranges.push(range);
      run = undefined;
    } else if (run?.endContainer === u.node && run.endOffset <= u.offset + 1) {
      run.setEnd(u.node, u.offset + 1);
    } else {
      run = document.createRange();
      run.setStart(u.node, u.offset);
      run.setEnd(u.node, u.offset + 1);
      ranges.push(run);
    }
  }
  return ranges;
}

/**
 * The extracted text a selection covers in a restored sentence: the selected
 * characters, and any touched formula whole.
 */
function restoredSelection(sentence: HTMLElement, range: Range) {
  const touched = sentenceUnits(sentence).filter((u) =>
    u.formula
      ? range.intersectsNode(u.formula)
      : range.comparePoint(u.node, u.offset) === 0 &&
        range.comparePoint(u.node, u.offset + 1) === 0,
  );
  if (!touched.length) return "";
  const s = Math.min(...touched.map((u) => u.from)),
    e = Math.max(...touched.map((u) => Math.max(u.to, u.from)));
  return compactSlice(sentence.dataset.anchor ?? "", s, e);
}

/**
 * Selected extracted text of one reflowed paragraph; a restored sentence maps
 * its selection back through its alignment.
 */
function selectedSource(node: HTMLElement, range: Range) {
  const sentences = sentenceNodes(node);
  if (!sentences.some((s) => s.dataset.anchor)) return clip(node, range);
  return sentences
    .filter((s) => range.intersectsNode(s))
    .map((s) =>
      s.dataset.anchor ? restoredSelection(s, range) : clip(s, range),
    )
    .reduce(
      (all, next) =>
        all + (all && next && needsSpace(all, next) ? " " : "") + next,
      "",
    );
}

/**
 * Ranges of a saved quote in reflowed text. A quote that crosses a restored
 * formula is not literal text there, so it is located in the joined extracted
 * text and mapped back sentence by sentence.
 */
export function reflowQuoteRanges(
  host: HTMLElement,
  blockId: string,
  quote: string,
): Range[] {
  const found = searchRanges(reflowSourceRanges(host, blockId), quote);
  const element = sourceElement(host, blockId);
  if (found.length || !element?.querySelector("[data-anchor]")) return found;
  const needle = compact(quote);
  if (!needle) return [];
  const nodes = sentenceNodes(element);
  const texts = nodes.map((s) =>
    compact(s.dataset.anchor ?? s.textContent ?? ""),
  );
  const start = texts.join("").indexOf(needle),
    end = start + needle.length;
  if (start < 0) return [];
  let offset = 0;
  return nodes.flatMap((s, i) => {
    const from = offset;
    offset += texts[i].length;
    if (offset <= start || from >= end) return [];
    const a = Math.max(start, from) - from,
      b = Math.min(end, offset) - from;
    if (s.dataset.anchor) return restoredRanges(s, a, b);
    return searchRanges(
      reflowSourceRanges(host, blockId, i),
      compactSlice(s.textContent ?? "", a, b),
    );
  });
}

// The text between non-space characters `a` and `b`, spaces inside kept.
function compactSlice(text: string, a: number, b: number) {
  let n = 0,
    out = "";
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (n > a && n < b) out += ch;
      continue;
    }
    if (n >= a && n < b) out += ch;
    n++;
  }
  return out;
}
