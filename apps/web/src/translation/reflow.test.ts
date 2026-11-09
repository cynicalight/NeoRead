// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import { reflowSourceParts, reflowSourceSelection } from "./reflow";

const translated = (
  sentences: TranslationBlock["sentences"],
): TranslationBlock => ({
  blockId: "b",
  sourceHash: "h",
  status: "complete",
  sentences,
});

it("splits untranslated text without changing it", () => {
  const text = "First sentence. Second one? Third.";
  const parts = reflowSourceParts(text);
  expect(parts.join("")).toBe(text);
  expect(parts).toHaveLength(3);
});

it("follows translated sentences using their extracted text", () => {
  expect(
    reflowSourceParts(
      "ignored",
      translated([
        { source: "Repaired one.", anchor: "Re- paired one.", target: "一" },
        { source: "Two.", target: "二" },
      ]),
    ),
  ).toEqual(["Re- paired one. ", "Two."]);
  // CJK sentences join without spaces.
  expect(
    reflowSourceParts(
      "",
      translated([
        { source: "第一句。", target: "a" },
        { source: "第二句。", target: "b" },
      ]),
    ),
  ).toEqual(["第一句。", "第二句。"]);
  // Failed or pending translations fall back to the extracted text.
  expect(
    reflowSourceParts("A. B.", { ...translated([]), status: "pending" }),
  ).toEqual(["A. ", "B."]);
});

it("turns a reflowed source selection into per-paragraph source anchors", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a"><span>Alpha text.</span></div>
    <div data-translation-block="a"><span>甲</span></div>
    <div data-reflow-source="b"><span>Beta text.</span></div>`;
  document.body.append(host);
  const blocks = ["a", "b"].map((id, i) => ({
    id,
    page: i + 1,
    label: "text",
    text: "",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  })) as PDFBlock[];
  const [alpha, , beta] = host.querySelectorAll("span");
  const range = document.createRange();
  range.setStart(alpha.firstChild!, 6);
  range.setEnd(beta.firstChild!, 4);
  Object.assign(range, { getBoundingClientRect: () => new DOMRect() });
  const selection = reflowSourceSelection(host, range, blocks)!;
  expect(selection.location).toEqual({
    type: "pdf",
    page: 1,
    quote: "text. Beta",
    sourceAnchors: [
      { blockId: "a", source: "text.", page: 1, bounds: blocks[0].bounds },
      { blockId: "b", source: "Beta", page: 2, bounds: blocks[1].bounds },
    ],
  });
  host.remove();
});
