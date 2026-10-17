import { expect, it } from "vitest";
import type { PDFBlock } from "@reader/core";
import { figureReferences, figureTarget } from "./figure-references";
const block = (
  id: string,
  label: string,
  text: string,
  x = 0.1,
  y = 0.1,
): PDFBlock => ({
  id,
  label,
  text,
  page: 1,
  bounds: { x, y, width: 0.3, height: 0.2 },
});
it("recognizes English, bracketed, Chinese, supplementary and subfigure references", () => {
  expect(
    figureReferences(
      "如图三，Figure 3, figure[12], Fig. 2(a), 图十二、Figure S1、Figure 2.1。",
    ).map((r) => r.label),
  ).toEqual(["3", "3", "12", "2", "12", "s1", "2.1"]);
  expect(figureReferences("[3] configuration 4 Figure 12word")).toEqual([]);
});
it("resolves only caption identities and never selects a matching body paragraph", () => {
  const image = {
    ...block("image", "image", ""),
    caption: "Figure 3. Results",
  };
  const body = block("body", "text", "Figure 3 illustrates the result.");
  expect(figureTarget([body, image], "3")).toBe(image);
  expect(figureTarget([body, image], "1")).toBeUndefined();
  expect(
    figureTarget([body, image, { ...image, id: "duplicate" }], "3"),
  ).toBeUndefined();
});
it("associates a separate caption with the adjacent image in the same column", () => {
  const image = block("image", "chart", "");
  const other = block("other", "image", "", 0.6);
  const caption = block("caption", "figure_title", "图三 实验结果", 0.1, 0.31);
  expect(figureTarget([other, caption, image], "3")).toBe(image);
  expect(figureTarget([other, caption], "3")).toBeUndefined();
  expect(figureTarget([{ ...image, page: 2 }, caption], "3")).toBeUndefined();
});

it.each([
  "Supplementary Figure S1. Results",
  "supplementary Fig. S1. Results",
  "Supplemental Figure S1. Results",
  "  Supplementary\nFigure S1. Results  ",
])("resolves supplementary captions: %s", (caption) => {
  const image = { ...block("image", "image", ""), caption };
  expect(figureTarget([image], "s1")).toBe(image);
  expect(figureTarget([image], "1")).toBeUndefined();
  const separate = block("caption", "figure_title", caption, 0.1, 0.31);
  const uncaptioned = block("image", "image", "");
  expect(figureTarget([uncaptioned, separate], "s1")).toBe(uncaptioned);
});

it("rejects incidental supplementary mentions and ambiguous supplementary targets", () => {
  const image = {
    ...block("image", "image", ""),
    caption: "Results shown in Supplementary Figure S1.",
  };
  expect(figureTarget([image], "s1")).toBeUndefined();
  const target = { ...image, caption: "Supplementary Figure S1. Results" };
  expect(
    figureTarget([target, { ...target, id: "duplicate" }], "s1"),
  ).toBeUndefined();
});
