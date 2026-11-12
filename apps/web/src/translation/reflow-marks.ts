import { lcsMatches } from "../text-align";
import { searchRanges } from "./search-ranges";
import {
  compact,
  reflowSourceElement,
  reflowSourceRanges,
  sentenceNodes,
  sentenceText,
} from "./reflow";
import { spanRanges } from "./reflow-alignment";

/**
 * Ranges of a saved quote in reflowed text, for marks made here, whose quote
 * is extracted text. It is found in the extracted text each sentence stands
 * for, then mapped back sentence by sentence; shown text is searched only
 * when that fails, since a repair may read the same words elsewhere.
 */
export function reflowQuoteRanges(
  host: HTMLElement,
  blockId: string,
  quote: string,
): Range[] {
  const element = reflowSourceElement(host, blockId);
  const sentences = element ? sentenceNodes(element) : [];
  const texts = sentences.map((s) => compact(sentenceText(s)));
  const needle = compact(quote);
  const at = needle ? texts.join("").indexOf(needle) : -1;
  if (at >= 0) return spanRanges(sentences, texts, at, at + needle.length);
  return searchRanges(reflowSourceRanges(host, blockId), quote);
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
    const element = reflowSourceElement(host, id);
    return element ? sentenceNodes(element) : [];
  });
  const raw = sentences.map(sentenceText);
  const texts = raw.map(compact);
  const span = edgeSpan(texts.join(""), compact(quote)) ?? wordSpan(raw, quote);
  return span ? spanRanges(sentences, texts, ...span) : [];
}

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
