import { alignedSpan } from "../text-align";
// Inputs use the same whitespace-free, lower-case text as PDF selection offsets.
// OCR sometimes moves mathematical subscripts to the end of a line. Match the
// complete prose in that case, retaining the original PDF offsets for painting.
const mathLetter = /[\u{1d400}-\u{1d7cb}]/u;

function prose(text: string) {
  let value = "",
    offset = 0;
  const starts: number[] = [],
    ends: number[] = [];
  for (const char of text) {
    if (!mathLetter.test(char)) {
      value += char;
      for (let i = 0; i < char.length; i++) {
        starts.push(offset);
        ends.push(offset + char.length);
      }
    }
    offset += char.length;
  }
  return { value, starts, ends };
}
function uniqueIndex(text: string, needle: string) {
  if (!needle) return -1;
  const start = text.indexOf(needle);
  return start >= 0 && text.indexOf(needle, start + 1) < 0 ? start : -1;
}
function symbols(text: string) {
  return Array.from(text)
    .filter((c) => mathLetter.test(c))
    .sort()
    .join("");
}

// The aligned span after `cursor`, so a repeated sentence never matches an
// earlier one.
function alignedFrom(text: string, source: string, cursor: number) {
  const from = Math.max(0, Math.min(cursor, text.length));
  const span = alignedSpan(text.slice(from), source);
  return span && { start: span.start + from, end: span.end + from };
}

export function sentenceTextRanges(
  text: string,
  block: string,
  sources: string[],
  sourceOffset = 0,
): Array<{ start: number; end: number }> {
  const paragraphStart = uniqueIndex(text, block);
  const pdfProse = prose(text),
    blockProse = prose(block);
  const proseStart = uniqueIndex(pdfProse.value, blockProse.value);
  const wholeParagraph =
    proseStart >= 0 &&
    symbols(block) ===
      symbols(
        text.slice(
          pdfProse.starts[proseStart],
          pdfProse.ends[proseStart + blockProse.value.length - 1],
        ),
      );
  const matches: Array<{ start: number; end: number }> = [];
  let cursor =
    paragraphStart >= 0 ? paragraphStart + sourceOffset : sourceOffset;
  let sourceCursor = sourceOffset;
  for (const source of sources) {
    if (!source) continue;
    const sourceStart = block.indexOf(source, sourceCursor);
    if (sourceStart >= 0) sourceCursor = sourceStart + source.length;
    const contextual =
      wholeParagraph && sourceStart >= 0
        ? proseStart + prose(block.slice(0, sourceStart)).value.length
        : -1;
    let start =
      paragraphStart >= 0 && sourceStart >= 0
        ? paragraphStart + sourceStart
        : contextual >= 0
          ? pdfProse.starts[contextual]
          : text.indexOf(source, cursor);
    if (start >= 0 && text.slice(start, start + source.length) === source) {
      cursor = start + source.length;
      matches.push({ start, end: cursor });
      continue;
    }
    const proseMatch = (
      start: number,
    ): { start: number; end: number } | undefined => {
      const needle = prose(source).value;
      // Without a complete paragraph match, require a unique substantial prose
      // sentence with the same variables. Paragraph context can also account for
      // subscripts that OCR has moved across sentence boundaries.
      if (
        !wholeParagraph &&
        (needle.length < 32 || needle.length < source.length * 0.8)
      )
        return;
      const projected =
        contextual >= 0 ? contextual : uniqueIndex(pdfProse.value, needle);
      if (
        !needle ||
        projected < 0 ||
        pdfProse.value.slice(projected, projected + needle.length) !== needle
      )
        return;
      start = pdfProse.starts[projected];
      const end = pdfProse.ends[projected + needle.length - 1];
      if (
        !wholeParagraph &&
        symbols(source) !== symbols(text.slice(start, end))
      )
        return;
      // Paragraph context resolves repeated sentences; otherwise require a
      // unique full-prose match. This never expands an unmatched sentence.
      return { start, end };
    };
    // Text whose subscripts the PDF orders differently still aligns.
    const match = proseMatch(start) ?? alignedFrom(text, source, cursor);
    if (match) {
      cursor = match.end;
      matches.push(match);
    }
  }
  return matches;
}
