import { lcsMatches } from "../text-align";

/**
 * One rendered piece of a restored sentence, a character or a whole formula,
 * with the span [from, to) of extracted-text characters (spaces removed) it
 * stands for. An unmatched piece has an empty span at its position. Spans
 * count UTF-16 code units, as `compact` text does, and never split a
 * character.
 */
interface Unit {
  node: Node;
  offset: number;
  /** Code units the rendered character takes. */
  length: number;
  formula?: Element;
  from: number;
  to: number;
}
/**
 * Non-space characters of `text` as comparison keys, each with the span
 * [start, end) of code units it comes from among non-space code units.
 * Compatibility forms fold, so a math italic letter or a ligature from the
 * extraction matches the plain letters a repair writes.
 */
function foldedKeys(text: string) {
  const keys: { key: string; start: number; end: number }[] = [];
  let n = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const start = n;
    n += ch.length;
    for (const key of ch.normalize("NFKC").toLowerCase())
      if (!/\s/.test(key)) keys.push({ key, start, end: n });
  }
  return keys;
}
/**
 * Aligns a restored sentence's rendered text with its extracted text: plain
 * characters by longest common subsequence, and each formula to the extracted
 * characters left between its matched neighbours.
 */
function sentenceUnits(sentence: HTMLElement): Unit[] {
  const anchor = foldedKeys(sentence.dataset.anchor ?? "");
  const size = anchor.at(-1)?.end ?? 0;
  const units: Unit[] = [];
  // Rendered keys, and the unit each comes from.
  const keys: string[] = [];
  const owners: number[] = [];
  const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const formula = node.parentElement?.closest("[data-tex]");
    if (formula) {
      if (units.at(-1)?.formula !== formula)
        units.push({
          node: formula,
          offset: 0,
          length: 0,
          formula,
          from: 0,
          to: 0,
        });
      continue;
    }
    const text = node.textContent ?? "";
    let offset = 0;
    for (const ch of text) {
      if (!/\s/.test(ch)) {
        for (const { key } of foldedKeys(ch)) {
          keys.push(key);
          owners.push(units.length);
        }
        units.push({ node, offset, length: ch.length, from: 0, to: 0 });
      }
      offset += ch.length;
    }
  }
  // The extracted span each unit's matched keys cover.
  const spans: ([number, number] | undefined)[] = units.map(() => undefined);
  lcsMatches(
    keys,
    anchor.map((a) => a.key),
  ).forEach((j, i) => {
    if (j === undefined) return;
    const { start, end } = anchor[j];
    const span = spans[owners[i]];
    spans[owners[i]] = span
      ? [Math.min(span[0], start), Math.max(span[1], end)]
      : [start, end];
  });
  units.forEach((u, k) => {
    const own = spans[k];
    if (own) {
      [u.from, u.to] = own;
      return;
    }
    // Between the matched neighbours: a formula covers that gap, an unmatched
    // character sits at its start.
    let before = 0,
      after = size;
    for (let j = k - 1; j >= 0; j--)
      if (spans[j]) {
        before = spans[j]![1];
        break;
      }
    for (let j = k + 1; j < units.length; j++)
      if (spans[j]) {
        after = spans[j]![0];
        break;
      }
    u.from = before;
    u.to = u.formula ? Math.max(before, after) : before;
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
    } else if (
      run?.endContainer === u.node &&
      run.endOffset <= u.offset + u.length
    ) {
      run.setEnd(u.node, u.offset + u.length);
    } else {
      run = document.createRange();
      run.setStart(u.node, u.offset);
      run.setEnd(u.node, u.offset + u.length);
      ranges.push(run);
    }
  }
  return ranges;
}

/**
 * The extracted text a selection covers in a restored sentence: the selected
 * characters, and any touched formula whole.
 */
export function restoredSelection(sentence: HTMLElement, range: Range) {
  const touched = sentenceUnits(sentence).filter((u) =>
    u.formula
      ? range.intersectsNode(u.formula)
      : range.comparePoint(u.node, u.offset) === 0 &&
        range.comparePoint(u.node, u.offset + u.length) === 0,
  );
  if (!touched.length) return "";
  const s = Math.min(...touched.map((u) => u.from)),
    e = Math.max(...touched.map((u) => Math.max(u.to, u.from)));
  return compactSlice(sentence.dataset.anchor ?? "", s, e);
}

/** Ranges of the span [start, end) of text without spaces across sentences. */
export function spanRanges(
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

// The text between non-space code units `a` and `b`, spaces inside kept; the
// same count `compact` and unit spans use.
function compactSlice(text: string, a: number, b: number) {
  let n = 0,
    out = "";
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (n > a && n < b) out += ch;
      continue;
    }
    if (n >= a && n < b) out += ch;
    n += ch.length;
  }
  return out;
}
