// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { Annotation, PDFBlock, TranslationBlock } from "@neoread/core";
import { translatedSelection } from "./selection";
import { translatedAnnotationRanges } from "./annotations";

it("does not include a sentence merely touched at its start boundary", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<section data-translation-block="a"><span data-sentence="0">第一句。</span><span data-sentence="1">第二句。</span></section>';
  const nodes = host.querySelectorAll("span"),
    range = document.createRange();
  range.setStart(nodes[0].firstChild!, 1);
  range.setEnd(nodes[1].firstChild!, 0);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  const block: PDFBlock = {
    id: "a",
    page: 1,
    label: "text",
    text: "First. Second.",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  };
  const translation: TranslationBlock = {
    blockId: "a",
    sourceHash: "hash",
    status: "complete",
    sentences: [
      { source: "First.", target: "第一句。" },
      { source: "Second.", target: "第二句。" },
    ],
  };
  const value = translatedSelection(host, range, [block], [translation])!;
  expect(value.links).toEqual([{ blockId: "a", sentenceIndexes: [0] }]);
  expect(value.passages[0].sources).toEqual(["First."]);
});
it("keeps all sentences and annotation ranges when a selection crosses paragraphs", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<section data-translation-block="a"><span data-sentence="0">第一句。</span><span data-sentence="1">第二句。</span></section><section data-translation-block="b"><span data-sentence="0">第三句。</span></section>';
  const blocks: PDFBlock[] = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "First. Second.",
      bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    },
    {
      id: "b",
      page: 1,
      label: "text",
      text: "Third.",
      bounds: { x: 0.1, y: 0.3, width: 0.3, height: 0.1 },
    },
  ];
  const translations: TranslationBlock[] = [
    {
      blockId: "a",
      sourceHash: "a-hash",
      status: "complete",
      sentences: [
        { source: "First.", target: "第一句。" },
        { source: "Second.", target: "第二句。" },
      ],
    },
    {
      blockId: "b",
      sourceHash: "b-hash",
      status: "complete",
      sentences: [{ source: "Third.", target: "第三句。" }],
    },
  ];
  const nodes = host.querySelectorAll("span"),
    range = document.createRange();
  range.setStart(nodes[1].firstChild!, 0);
  range.setEnd(nodes[2].firstChild!, 4);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 100),
  });
  const result = translatedSelection(host, range, blocks, translations)!;
  expect(result.links).toEqual([
    { blockId: "a", sentenceIndexes: [1] },
    { blockId: "b", sentenceIndexes: [0] },
  ]);
  expect(result.passages.map((p) => p.sourceOffset)).toEqual([6, 0]);
  expect(result.selection.text).toBe("第二句。\n\n第三句。");
  expect(result.selection.location.translation?.ranges?.[0]).toMatchObject({
    sourceText: "Second.",
    targetText: "第一句。第二句。",
    wholeSentence: true,
  });
  const annotation = {
    id: "n",
    documentId: "doc",
    kind: "highlight",
    quote: result.selection.text,
    location: result.selection.location,
    note: "",
    color: "yellow",
    createdAt: "",
  } as Annotation;
  expect(
    translatedAnnotationRanges(host, [annotation], translations).map((r) =>
      r.range.toString(),
    ),
  ).toEqual(["第二句。", "第三句。"]);
});
