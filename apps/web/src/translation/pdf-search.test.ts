import { expect, it } from "vitest";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
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

it("returns the complete matching sentence rather than a character window", () => {
  const sentence =
    "An extraordinarily long introductory clause explains why the target appears here and continues with enough additional detail to exceed the old excerpt window comfortably.";
  const text = `An unrelated sentence. ${sentence} Another unrelated sentence.`;
  const results = searchPDFBlocks("target", [{ ...blocks[0], text }], []);
  expect(results[0].excerpt).toBe(sentence);
});

it("returns complete Chinese sentences and preserves phrases spanning sentences", () => {
  const text = "上一句。这里包含目标词，后面还有说明。下一句。";
  expect(searchPDFBlocks("目标", [{ ...blocks[0], text }], [])[0].excerpt).toBe(
    "这里包含目标词，后面还有说明。",
  );
  expect(
    searchPDFBlocks("说明。下一", [{ ...blocks[0], text }], [])[0].excerpt,
  ).toBe("这里包含目标词，后面还有说明。下一句。");
});

it("anchors translated matches to their side and sentence offsets", () => {
  const translated = [
    {
      ...translations[0],
      sentences: [
        { source: "First sentence.", target: "第一句。" },
        { source: "Second sentence.", target: "第二句。" },
      ],
    },
  ];
  const result = searchPDFBlocks("第二", blocks, translated)[0];
  expect(result.excerpt).toBe("第二句。");
  expect(result.location).toMatchObject({
    translation: {
      blockId: "one",
      sourceHash: "a",
      sentenceIndexes: [1],
      start: 4,
      end: 6,
    },
  });
});
