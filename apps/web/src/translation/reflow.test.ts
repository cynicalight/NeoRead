// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import {
  reflowQuoteRanges,
  reflowSourceParts,
  reflowSourceSelection,
  reflowBlockText,
  reflowMarkRanges,
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

it("follows translated sentences, showing close repairs", () => {
  expect(
    reflowSourceParts(
      "ignored",
      translated([
        { source: "Repaired one.", anchor: "Re- paired one.", target: "一" },
        { source: "Two.", target: "二" },
      ]),
    ),
  ).toEqual([
    { text: "Re- paired one. ", display: "Repaired one. " },
    { text: "Two." },
  ]);
  // Math italic letters fold into the plain letters the model writes.
  expect(
    reflowSourceParts(
      "",
      translated([
        { source: "Let x be fixed.", anchor: "Let 𝑥 be fi xed.", target: "a" },
      ]),
    ),
  ).toEqual([{ text: "Let 𝑥 be fi xed.", display: "Let x be fixed." }]);
  // A rewrite that drops much of the extracted text keeps the extracted text.
  expect(
    reflowSourceParts(
      "",
      translated([
        {
          source: "The model is trained.",
          anchor: "We train the model on data.",
          target: "a",
        },
      ]),
    ),
  ).toEqual([{ text: "We train the model on data." }]);
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

it("stores a selection across a formula as just its extracted text", () => {
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
    quote: "start. Dim d k",
    sourceAnchors: [{ blockId: "a", source: "start. Dim d k" }],
  });
  host.remove();
});

it("marks the formula and plain text a saved quote covers", () => {
  const host = restored();
  expect(
    reflowQuoteRanges(host, "a", "start.").map((r) => r.toString()),
  ).toEqual(["start."]);
  expect(
    reflowQuoteRanges(host, "a", "Dim d k").map((r) => r.toString()),
  ).toEqual(["Dim", "dk"]);
  // A quote crossing into a restored sentence keeps the plain part exact.
  expect(
    reflowQuoteRanges(host, "a", "start. Dim d k").map((r) => r.toString()),
  ).toEqual(["start.", "Dim", "dk"]);
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

it("maps a selection in a repaired sentence back to its extracted text", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a">
      <span data-source-sentence="0" data-anchor="An inter- national ef fort.">An international effort.</span>
    </div>`;
  document.body.append(host);
  const blocks = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    },
  ] as PDFBlock[];
  const text = host.querySelector("span")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 3);
  range.setEnd(text, "An international effort".length);
  Object.assign(range, { getBoundingClientRect: () => new DOMRect() });
  const selection = reflowSourceSelection(host, range, blocks)!;
  expect(selection.text).toBe("international effort");
  expect(selection.location).toMatchObject({
    sourceAnchors: [{ blockId: "a", source: "inter- national ef fort" }],
  });
  // A quote saved from the PDF marks the repaired words.
  expect(
    reflowQuoteRanges(host, "a", "national ef fort").map((r) => r.toString()),
  ).toEqual(["national effort"]);
  host.remove();
});

it("maps past math italic letters the repair wrote plainly", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a">
      <span data-source-sentence="0" data-anchor="Let 𝑥 be fi xed.">Let x be fixed.</span>
    </div>`;
  document.body.append(host);
  const blocks = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    },
  ] as PDFBlock[];
  const text = host.querySelector("span")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, "Let ".length);
  range.setEnd(text, "Let x be fixed".length);
  Object.assign(range, { getBoundingClientRect: () => new DOMRect() });
  // The surrogate pair counts as two code units on both sides.
  expect(reflowSourceSelection(host, range, blocks)!.location).toMatchObject({
    sourceAnchors: [{ blockId: "a", source: "𝑥 be fi xed" }],
  });
  expect(
    reflowQuoteRanges(host, "a", "𝑥 be fi xed").map((r) => r.toString()),
  ).toEqual(["x be fixed"]);
  host.remove();
});

it("finds a saved quote in extracted text before shown text", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a">
      <span data-source-sentence="0" data-anchor="Let 𝑥 grow. ">Let x grow. </span><span data-source-sentence="1">Then x grows.</span>
    </div>`;
  document.body.append(host);
  const [, second] = host.querySelectorAll("span");
  const ranges = reflowQuoteRanges(host, "a", "x grow");
  // The quote was taken from the second sentence's extracted text.
  expect(ranges.map((r) => r.toString())).toEqual(["x grow"]);
  expect(ranges[0].startContainer).toBe(second.firstChild);
  host.remove();
});

it("maps both ways around subscripts the extraction moved", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a">
      <span data-source-sentence="0" data-anchor="maps ( x , ..., x ) to a sequence 1 n of z."><span>maps <span class="markdown-math" data-tex="(x_1, ..., x_n)"><span class="katex">(x1,...,xn)</span></span> to a sequence of z.</span></span>
    </div>`;
  document.body.append(host);
  const marked = (quote: string) =>
    reflowQuoteRanges(host, "a", quote).map((r) => r.toString());
  // From the PDF: the formula alone, and plain text past the moved subscripts.
  expect(marked("( x , ..., x )")).toEqual(["(x1,...,xn)"]);
  expect(marked("x ) to a sequence 1 n")).toEqual([
    "(x1,...,xn)",
    "to a sequence",
  ]);
  // To the PDF: the selected plain text keeps what the extraction put between.
  const text = host.querySelector(".katex")!.parentElement!.nextSibling!;
  const range = document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, " to a sequence of".length);
  Object.assign(range, { getBoundingClientRect: () => new DOMRect() });
  const blocks = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    },
  ] as PDFBlock[];
  expect(reflowSourceSelection(host, range, blocks)!.location).toMatchObject({
    quote: "to a sequence 1 n of",
  });
  host.remove();
});

it("finds a text-layer quote across paragraphs by its ends, then word by word", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-reflow-source="a"><span data-source-sentence="0">We suspect that for large values of d , the dot products grow large. </span><span data-source-sentence="1">To counteract this effect, we scale the dot products by √ d .</span></div>
    <div data-reflow-source="b"><span data-source-sentence="0">Instead of performing a single attention function with d -dimensional keys.</span></div>`;
  document.body.append(host);
  const marked = (quote: string) =>
    reflowMarkRanges(host, ["a", "b"], quote)
      .map((r) => r.toString())
      .join("|");
  // Ends found by their first and last ten characters, across paragraphs.
  expect(
    marked("we scale the dot products by √dk. Instead of performing"),
  ).toBe("we scale the dot products by √ d .|Instead of performing");
  // A quote starting on a subscript the paragraph moved matches word by word
  // from its first matched word.
  expect(marked("dk, the dot products grow large. To counteract")).toBe(
    "the dot products grow large.|To counteract",
  );
  // Mostly unmatched words do not place a quote.
  expect(marked("dk th")).toBe("");
  host.remove();
});
