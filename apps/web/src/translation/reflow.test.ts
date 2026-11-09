// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import {
  reflowQuoteRanges,
  reflowSourceParts,
  reflowSourceSelection,
  reflowBlockText,
} from "./reflow";

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
  expect(parts.map((p) => p.text).join("")).toBe(text);
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
  ).toEqual([{ text: "Re- paired one. " }, { text: "Two." }]);
  // CJK sentences join without spaces.
  expect(
    reflowSourceParts(
      "",
      translated([
        { source: "第一句。", target: "a" },
        { source: "第二句。", target: "b" },
      ]),
    ),
  ).toEqual([{ text: "第一句。" }, { text: "第二句。" }]);
  // Failed or pending translations fall back to the extracted text.
  expect(
    reflowSourceParts("A. B.", { ...translated([]), status: "pending" }),
  ).toEqual([{ text: "A. " }, { text: "B." }]);
});

it("shows sentences whose model text restores inline math as KaTeX", () => {
  expect(
    reflowSourceParts(
      "",
      translated([
        {
          source: "Keys have dimension $d_k$.",
          anchor: "Keys have dimension d .",
          target: "键的维度为 $d_k$。",
        },
        { source: "It costs \\$5 and \\$6.", target: "花费 5 和 6。" },
      ]),
    ),
  ).toEqual([
    {
      text: "Keys have dimension d . ",
      display: "Keys have dimension $d_k$. ",
    },
    // Escaped dollar signs are not math.
    { text: "It costs \\$5 and \\$6." },
  ]);
});

const restored = () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a">
      <span data-source-sentence="0">Plain start. </span><span data-source-sentence="1" data-anchor="Dim d k here."><span>Dim <span class="markdown-math" data-tex="d_k"><span class="katex">dk</span></span> here.</span></span>
    </div>`;
  document.body.append(host);
  return host;
};

it("selects restored formulas by their whole extracted sentence", () => {
  const host = restored();
  const blocks = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    },
  ] as PDFBlock[];
  const plain = host.querySelector("span")!;
  const range = document.createRange();
  range.setStart(plain.firstChild!, 6);
  range.setEnd(host.querySelector(".katex")!.firstChild!, 1);
  Object.assign(range, { getBoundingClientRect: () => new DOMRect() });
  const selection = reflowSourceSelection(host, range, blocks)!;
  // A partly selected formula reads whole as TeX.
  expect(selection.text).toBe("start. Dim $d_k$");
  expect(selection.location).toMatchObject({
    quote: "start. Dim d k here.",
    sourceAnchors: [{ blockId: "a", source: "start. Dim d k here." }],
  });
  host.remove();
});

it("marks restored sentences that a saved quote covers", () => {
  const host = restored();
  expect(
    reflowQuoteRanges(host, "a", "start.").map((r) => r.toString()),
  ).toEqual(["start."]);
  expect(
    reflowQuoteRanges(host, "a", "Dim d k").map((r) => r.toString()),
  ).toEqual(["Dim ", "dk", " here."]);
  host.remove();
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

it("copies a reflowed paragraph as restored source, a blank line and its translation", () => {
  const translation = {
    blockId: "a",
    sourceHash: "h",
    status: "complete",
    sentences: [
      { source: "Plain start.", target: "开头。" },
      {
        source: "Dim $d_k$ here.",
        anchor: "Dim d k here.",
        target: "维度 $d_k$。",
      },
    ],
  } as TranslationBlock;
  expect(reflowBlockText("Plain start. Dim d k here.", translation)).toBe(
    "Plain start. Dim $d_k$ here.\n\n开头。维度 $d_k$。",
  );
  expect(reflowBlockText("Only source.")).toBe("Only source.");
});
