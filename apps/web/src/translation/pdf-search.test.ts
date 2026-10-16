import { expect, it } from "vitest";
import type { PDFBlock, TranslationBlock } from "@reader/core";
import { searchPDFBlocks } from "./pdf-search";

const blocks: PDFBlock[] = [
  {
    id: "one",
    page: 2,
    label: "paragraph",
    bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
    text: "garbled source",
  },
  {
    id: "two",
    page: 3,
    label: "paragraph",
    bounds: { x: 0.2, y: 0.3, width: 0.7, height: 0.1 },
    text: "raw fallback raw",
  },
];
const translations: TranslationBlock[] = [
  {
    blockId: "one",
    sourceHash: "a",
    status: "complete",
    sentences: [
      { source: "repaired source source", target: "译文结果 译文结果" },
    ],
  },
];

it("searches repaired originals and translations with block anchors", () => {
  const source = searchPDFBlocks("source", blocks, translations);
  expect(source).toHaveLength(2);
  expect(
    source.map(
      (result) =>
        result.location.type === "pdf" && result.location.quoteContext?.start,
    ),
  ).toEqual([9, 16]);
  expect(source.map((result) => result.blockId)).toEqual(["one", "one"]);
  expect(source[0].location).toMatchObject({
    type: "pdf",
    page: 2,
    quote: "source",
    x: 0.5,
    y: 0.25,
  });
  expect(searchPDFBlocks("garbled", blocks, translations)).toEqual([]);
  const target = searchPDFBlocks("译文结果", blocks, translations);
  expect(target).toHaveLength(2);
  expect(target[0].side).toBe("translation");
  expect(searchPDFBlocks("raw", blocks, translations)).toHaveLength(2);
});

it("does not return stale translation text before completion", () => {
  const pending = [{ ...translations[0], status: "pending" as const }];
  expect(searchPDFBlocks("译文", blocks, pending)).toEqual([]);
  expect(searchPDFBlocks("garbled", blocks, pending)).toHaveLength(1);
});
