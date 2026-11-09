import { expect, it } from "vitest";
import { sentenceTextRanges } from "./pdf-sentence-matching";

const normalized = (s: string) => s.toLowerCase().replace(/\s/g, "");
const source = normalized(
  "Each time 𝑡 merges a 𝑖 record-local graph, it checks all followers.",
);
const pdf = normalized(
  "Each time 𝑡𝑖 merges a record-local graph, it checks all followers.",
);

it("keeps reordered subscripts in the full PDF sentence range", () => {
  const text = "preceding." + pdf + "following.";
  expect(sentenceTextRanges(text, source, [source])).toEqual([
    { start: 10, end: 10 + pdf.length },
  ]);
});

it("does not accept different prose or different mathematical variables", () => {
  expect(
    sentenceTextRanges(pdf.replace("allfollowers", "nofollowers"), source, [
      source,
    ]),
  ).toEqual([]);
  expect(sentenceTextRanges(pdf.replace("𝑖", "𝑗"), source, [source])).toEqual(
    [],
  );
  expect(
    sentenceTextRanges("𝑡𝑖=1.", "Unrelated paragraph.", ["𝑡=1𝑖."]),
  ).toEqual([]);
});

it("uses the full paragraph when OCR moves a subscript across a sentence boundary", () => {
  const first = normalized(
    "Each time 𝑡 merges a record-local graph, it checks all followers.",
  );
  const second = normalized(
    "𝑖 The transaction checks every record before committing.",
  );
  const actualSecond = normalized(
    "The transaction checks every record before committing.",
  );
  const text = pdf + actualSecond;
  expect(sentenceTextRanges(text, first + second, [first, second])).toEqual([
    { start: 0, end: pdf.length },
    { start: pdf.length, end: text.length },
  ]);
});

it("rejects ambiguous prose without paragraph context and resolves it with source order", () => {
  const paragraph = source + source;
  const text = pdf + pdf;
  expect(sentenceTextRanges(text, "Unrelated paragraph.", [source])).toEqual(
    [],
  );
  expect(sentenceTextRanges(text, paragraph, [source], source.length)).toEqual([
    { start: pdf.length, end: pdf.length * 2 },
  ]);
});

it("aligns a repeated sentence after the ones before it", () => {
  const text = "thevalueofdkispositive.".repeat(2);
  const block = "thevalueofdispositivek.".repeat(2);
  const sentence = "thevalueofdispositivek.";
  expect(sentenceTextRanges(text, block, [sentence], 23)).toEqual([
    { start: 23, end: 46 },
  ]);
  expect(sentenceTextRanges(text, block, [sentence, sentence])).toEqual([
    { start: 0, end: 23 },
    { start: 23, end: 46 },
  ]);
});
