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

// Version-4 extraction retains inline LaTeX structure. Match the surrounding
// prose exactly and verify every formula's variable/number multiset against
// native PDF glyphs before projecting sentence offsets onto that paragraph.
function inlineMathProjection(text: string, block: string) {
  if (!block.includes("$")) return;
  const parts: { text: string; math: boolean }[] = [];
  let offset = 0;
  for (const match of block.matchAll(/(?<!\\)\$(?:\\.|[^$])+\$/g)) {
    if (
      !/\\(?:mathcal|mathbb|mathbf|tilde|hat|bar|dot|ddot)\b|[_^]\{/.test(
        match[0],
      )
    )
      continue;
    parts.push(
      { text: block.slice(offset, match.index), math: false },
      { text: match[0], math: true },
    );
    offset = match.index! + match[0].length;
  }
  if (!offset) return;
  parts.push({ text: block.slice(offset), math: false });
  if (
    parts
      .filter((p) => !p.math)
      .map((p) => p.text)
      .join("")
      .replace(/[^\p{L}]/gu, "").length < 32
  )
    return;
  const escaped = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    parts
      .map((p) =>
        p.math
          ? `(.{0,${Math.max(8, p.text.length * 2)}}?)`
          : `(${escaped(p.text)})`,
      )
      .join(""),
    "g",
  );
  const found = pattern.exec(text);
  if (!found) return;
  pattern.lastIndex = found.index + 1;
  if (pattern.exec(text)) return;
  const variables = (value: string) =>
    Array.from(
      value
        .replace(/[˜ˆ¯˙¨]/g, "")
        .replace(/\\[a-z]+/gi, "")
        .normalize("NFKD"),
    )
      .filter((c) => /[\p{L}\p{N}]/u.test(c))
      .sort()
      .join("");
  const starts: number[] = [],
    ends: number[] = [];
  let at = found.index;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i],
      actual = found[i + 1];
    if (part.math && variables(part.text) !== variables(actual)) return;
    for (let j = 0; j < part.text.length; j++) {
      starts.push(part.math ? at : at + j);
      ends.push(part.math ? at + actual.length : at + j + 1);
    }
    at += actual.length;
  }
  return { starts, ends };
}

export function sentenceTextRanges(
  text: string,
  block: string,
  sources: string[],
  sourceOffset = 0,
): Array<{ start: number; end: number }> {
  const inline = inlineMathProjection(text, block);
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
    if (inline && sourceStart >= 0) {
      const start = inline.starts[sourceStart],
        end = inline.ends[sourceStart + source.length - 1];
      matches.push({ start, end });
      cursor = end;
      continue;
    }
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
    const needle = prose(source).value;
    // Without a complete paragraph match, require a unique substantial prose
    // sentence with the same variables. Paragraph context can also account for
    // subscripts that OCR has moved across sentence boundaries.
    if (
      !wholeParagraph &&
      (needle.length < 32 || needle.length < source.length * 0.8)
    )
      continue;
    const projected =
      contextual >= 0 ? contextual : uniqueIndex(pdfProse.value, needle);
    if (
      !needle ||
      projected < 0 ||
      pdfProse.value.slice(projected, projected + needle.length) !== needle
    )
      continue;
    start = pdfProse.starts[projected];
    const end = pdfProse.ends[projected + needle.length - 1];
    if (!wholeParagraph && symbols(source) !== symbols(text.slice(start, end)))
      continue;
    // Paragraph context resolves repeated sentences; otherwise require a
    // unique full-prose match. This never expands an unmatched sentence.
    cursor = end;
    matches.push({ start, end });
  }
  return matches;
}
