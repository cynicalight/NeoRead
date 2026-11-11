// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, PDFBlock, ReaderAdapter } from "@neoread/core";
import { pdfSourceMarkRanges } from "./pdf-source-marks";

const bounds = { x: 0, y: 0, width: 1, height: 1 };
const blocks = [
  { id: "b", page: 1, label: "text", bounds, text: "Alpha beta. Alpha gamma." },
] as PDFBlock[];
const mark = (location: Annotation["location"]): Annotation => ({
  id: "a",
  documentId: "doc",
  kind: "highlight",
  quote: "",
  note: "",
  color: "#e6b94c",
  createdAt: "",
  location,
});
const anchor = { blockId: "b", page: 1, bounds, source: "Alpha" };
const texts = (ranges: Range[]) => ranges.map((r) => r.toString());
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => host.remove());
const reflow = () => {
  host.innerHTML =
    '<div data-reflow-source="b">' +
    '<span data-source-sentence="0">Alpha beta. </span>' +
    '<span data-source-sentence="1">Alpha gamma.</span></div>';
};

it("uses saved offsets while the paragraph renders the same text", () => {
  reflow();
  const ranges = pdfSourceMarkRanges(
    host,
    mark({
      type: "pdf",
      page: 1,
      sourceAnchors: [
        { ...anchor, start: 12, end: 17, text: "Alpha beta. Alpha gamma." },
      ],
    }),
    blocks,
    {} as ReaderAdapter,
  );
  expect(texts(ranges)).toEqual(["Alpha"]);
  expect(ranges[0].startContainer.parentElement?.dataset.sourceSentence).toBe(
    "1",
  );
});

it("finds the quote instead when the rendered paragraph has changed", () => {
  reflow();
  const ranges = pdfSourceMarkRanges(
    host,
    mark({
      type: "pdf",
      page: 1,
      sourceAnchors: [
        { ...anchor, source: "gamma", start: 3, end: 8, text: "Older text." },
      ],
    }),
    blocks,
    {} as ReaderAdapter,
  );
  expect(texts(ranges)).toEqual(["gamma"]);
});

it("finds a text-layer mark in the reflowed paragraphs under its rectangles", () => {
  reflow();
  const ranges = pdfSourceMarkRanges(
    host,
    mark({
      type: "pdf",
      page: 1,
      quote: "beta. Alpha",
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
    }),
    blocks,
    {} as ReaderAdapter,
  );
  // One range per sentence; the space between them is not marked.
  expect(texts(ranges)).toEqual(["beta.", "Alpha"]);
});

it("asks the PDF view for a reflow mark shown in the text layer", () => {
  const sentenceRanges = vi.fn(() => [document.createRange()]);
  const ranges = pdfSourceMarkRanges(
    host,
    mark({ type: "pdf", page: 1, sourceAnchors: [anchor] }),
    blocks,
    { sentenceRanges } as unknown as ReaderAdapter,
  );
  expect(ranges).toHaveLength(1);
  expect(sentenceRanges).toHaveBeenCalledWith([
    expect.objectContaining({ blockId: "b", sources: ["Alpha"] }),
  ]);
});
