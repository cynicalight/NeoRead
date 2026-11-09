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
import { lcsMatches } from "../text-align";

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
 * Ranges of a saved quote in reflowed text, for marks made here, whose quote
 * is extracted text. Its span is mapped back sentence by sentence.
 */
export function reflowQuoteRanges(
  host: HTMLElement,
  blockId: string,
  quote: string,
): Range[] {
  const found = searchRanges(reflowSourceRanges(host, blockId), quote);
  const element = sourceElement(host, blockId);
  if (found.length || !element?.querySelector("[data-anchor]")) return found;
  const sentences = sentenceNodes(element);
  const texts = sentences.map((s) => compact(sentenceText(s)));
  const needle = compact(quote);
  const at = needle ? texts.join("").indexOf(needle) : -1;
  return at < 0 ? [] : spanRanges(sentences, texts, at, at + needle.length);
}

/**
 * Ranges of a quote from the PDF text layer in the reflowed paragraphs it
 * covers. The text layer and the extracted paragraphs can differ around
 * formulas, so the quote is found by its first and last ten characters, and
 * failing that word by word: the span runs from the first to the last matched
 * word with at most 20% unmatched words, dropping its sparser end until so.
 */
export function reflowMarkRanges(
  host: HTMLElement,
  blockIds: string[],
  quote: string,
): Range[] {
  const sentences = blockIds.flatMap((id) => {
    const element = sourceElement(host, id);
    return element ? sentenceNodes(element) : [];
  });
  const raw = sentences.map(sentenceText);
  const texts = raw.map(compact);
  const span = edgeSpan(texts.join(""), compact(quote)) ?? wordSpan(raw, quote);
  return span ? spanRanges(sentences, texts, ...span) : [];
}

// A restored sentence stands for its extracted text; a plain one shows it.
const sentenceText = (s: HTMLElement) =>
  s.dataset.anchor ?? s.textContent ?? "";

function edgeSpan(text: string, needle: string): [number, number] | undefined {
  if (!needle) return;
  const at = text.indexOf(needle);
  if (at >= 0) return [at, at + needle.length];
  if (needle.length < 20) return;
  const start = text.indexOf(needle.slice(0, 10));
  const tail = start < 0 ? -1 : text.indexOf(needle.slice(-10), start + 10);
  return tail < 0 ? undefined : [start, tail + 10];
}

// Words with their [start, end) in text without spaces.
function words(text: string) {
  const offsets: number[] = [];
  let n = 0;
  for (let i = 0; i <= text.length; i++) {
    offsets.push(n);
    if (i < text.length && !/\s/.test(text[i])) n++;
  }
  const found =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "word" }).segment(text),
        ).flatMap((w) =>
          w.isWordLike ? [{ text: w.segment, index: w.index }] : [],
        )
      : Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (m) => ({
          text: m[0],
          index: m.index,
        }));
  return found.map((w) => ({
    word: w.text.toLowerCase(),
    start: offsets[w.index],
    end: offsets[w.index + w.text.length],
  }));
}

function wordSpan(
  texts: string[],
  quote: string,
): [number, number] | undefined {
  let base = 0;
  const pool = texts.flatMap((text) => {
    const found = words(text).map((w) => ({
      ...w,
      start: w.start + base,
      end: w.end + base,
    }));
    base += compact(text).length;
    return found;
  });
  const wanted = words(quote).map((w) => w.word);
  const at = lcsMatches(
    pool.map((w) => w.word),
    wanted,
  );
  const hits = at.flatMap((j, i) => (j === undefined ? [] : [i]));
  // Too few shared words cannot place the quote.
  if (hits.length < wanted.length / 2) return;
  let s = 0,
    e = hits.length - 1;
  while (s <= e) {
    const total = hits[e] - hits[s] + 1;
    if (total - (e - s + 1) <= total * 0.2)
      return [pool[hits[s]].start, pool[hits[e]].end];
    // Drop the end farther from its neighbouring match.
    if (hits[s + 1] - hits[s] >= hits[e] - hits[e - 1]) s++;
    else e--;
  }
}

// Ranges of the span [start, end) of text without spaces across sentences.
function spanRanges(
  sentences: HTMLElement[],
  texts: string[],
  start: number,
  end: number,
): Range[] {
  let offset = 0;
  return sentences.flatMap((s, i) => {
    const from = offset;
    offset += texts[i].length;
    if (offset <= start || from >= end) return [];
    const a = Math.max(start, from) - from,
      b = Math.min(end, offset) - from;
    return s.dataset.anchor ? restoredRanges(s, a, b) : plainRanges(s, a, b);
  });
}

// Ranges of the non-space characters [a, b) of a plain sentence.
function plainRanges(sentence: HTMLElement, a: number, b: number) {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
  let node: Node | null,
    n = 0;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    let from = -1,
      to = -1;
    for (let k = 0; k < text.length; k++) {
      if (/\s/.test(text[k])) continue;
      if (n >= a && n < b) {
        if (from < 0) from = k;
        to = k + 1;
      }
      n++;
    }
    if (from < 0) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    ranges.push(range);
  }
  return ranges;
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
