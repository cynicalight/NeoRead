// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import { translatedSelection } from "../translation/selection";
import oze from "./fixtures/oze-sentence-alignment.json";
vi.mock("pdfjs-dist", () => ({
  Util: { transform: (_a: number[], b: number[]) => b },
}));
import { PDFReadingNavigation } from "./pdf-navigation";

let host: HTMLDivElement, page: HTMLDivElement, nav: PDFReadingNavigation;
let registry: Map<string, Set<Range>>;
let currentBlock: PDFBlock;
const block: PDFBlock = {
  id: "paragraph",
  page: 1,
  label: "text",
  text: "Before. The function add_target_records() identifies the records. It first retrieves all followers. After.",
  bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 },
};
const sources = [
  "Before.",
  "The function add_target_records() identifies the records.",
  "It first retrieves all followers.",
  "After.",
];
function textLayer() {
  page.innerHTML =
    '<div class="textLayer"><span>Before. The function </span><span>add_target_records()</span><span> identifies the records. It first retrieves all followers. After.</span></div>';
  page.querySelectorAll("span").forEach((span, i) => {
    span.getBoundingClientRect = () => new DOMRect(100, 100 + i * 30, 800, 20);
  });
}
const markedText = () =>
  [...registry.values()].flatMap((h) => [...h].map((r) => r.toString()));
beforeEach(() => {
  currentBlock = block;
  registry = new Map();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  host = document.createElement("div");
  page = document.createElement("div");
  host.append(page);
  document.body.append(host);
  page.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 1000);
  textLayer();
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  nav = new PDFReadingNavigation(
    host,
    { getPageView: () => ({ div: page }) } as unknown as PDFViewer,
    async () =>
      ({
        getViewport: () => ({ width: 1000, height: 1000, transform: [] }),
        getTextContent: async () => ({ items: [], styles: {} }),
      }) as unknown as PDFPageProxy,
    () => [currentBlock],
    { location: vi.fn(), selection: vi.fn() },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(100, 100, 800, 20)],
  });
});

it("maps the real page 6 cached sentences to PDF text despite displaced mathematical subscripts", async () => {
  currentBlock = oze.block;
  const layer = page.querySelector(".textLayer")!;
  layer.replaceChildren(
    ...oze.runs.map(({ text, bounds: b }) => {
      const span = document.createElement("span");
      span.textContent = text;
      span.getBoundingClientRect = () =>
        new DOMRect(b.x * 1000, b.y * 1000, b.width * 1000, b.height * 1000);
      return span;
    }),
  );
  const sources = oze.sentences.slice(1, 3).map((s) => s.source);
  const normalize = (s: string) => s.replace(/[\s\u00ad]/g, "");
  await nav.focusPassages([
    {
      blockId: oze.block.id,
      sources,
      sourceOffset: normalize(oze.sentences[0].source).length,
    },
  ]);
  expect(markedText().map(normalize)).toEqual([
    normalize(
      "Each time 𝑡𝑖 merges a record-local graph, it checks the acyclicity of the resulting graph and identifies all its followers.",
    ),
    normalize(
      "If a follower of 𝑡𝑖 exists, 𝑡𝑖 merges record-local graphs of the records read or written by that follower and repeats identifying its followers and merging the record-local graphs.",
    ),
  ]);
  await nav.focusPassages([
    {
      blockId: oze.block.id,
      sources: [oze.sentences[3].source],
      sourceOffset: normalize(
        oze.sentences
          .slice(0, 3)
          .map((s) => s.source)
          .join(""),
      ).length,
    },
  ]);
  expect(markedText().join("")).toContain(
    "to the finalizing phase for committing.",
  );
  expect(page.querySelector(".neoread-linked-highlight")).toBeNull();
});
afterEach(() => {
  nav.destroy();
  host.remove();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getClientRects;
  vi.unstubAllGlobals();
});

it("highlights whole source sentences for a partial translation selection using text ranges, preserving the native selection", async () => {
  const translation = document.createElement("div");
  translation.innerHTML =
    '<section data-translation-block="paragraph"><span data-sentence="0">之前。</span><span data-sentence="1">函数确定目标记录。</span><span data-sentence="2">它首先获取所有后继事务。</span><span data-sentence="3">之后。</span></section>';
  host.append(translation);
  const sentences = translation.querySelectorAll("span");
  const range = document.createRange();
  range.setStart(sentences[1].firstChild!, 2);
  range.setEnd(sentences[2].firstChild!, 4);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  window.getSelection()!.addRange(range);
  const translations: TranslationBlock[] = [
    {
      blockId: block.id,
      sourceHash: "hash",
      status: "complete",
      sentences: sources.map((source, i) => ({
        source,
        target: sentences[i].textContent!,
      })),
    },
  ];
  const value = translatedSelection(translation, range, [block], translations)!;
  await nav.focusPassages(value.passages);
  expect(markedText()).toEqual(sources.slice(1, 3));
  expect(window.getSelection()!.getRangeAt(0)).toBe(range);
  expect(window.getSelection()!.toString()).toBe("确定目标记录。它首先获");
  expect(page.querySelector(".neoread-linked-highlight")).toBeNull();
});

it("never paints a paragraph rectangle for an unmatched sentence and keeps other matched sentences", async () => {
  await nav.focusPassages([
    { blockId: block.id, sources: ["Unavailable sentence.", sources[2]] },
  ]);
  expect(page.querySelector(".neoread-linked-highlight")).toBeNull();
  expect(markedText()).toEqual([sources[2]]);
});

it("replaces ranges after text layer rebuild and clears them on dismissal and disposal", async () => {
  const passages = [{ blockId: block.id, sources: [sources[1]] }];
  await nav.focusPassages(passages);
  const oldRange = [...registry.values()][0]?.values().next().value;
  expect(oldRange).toBeDefined();
  textLayer();
  nav.repaint();
  nav.repaint();
  expect(markedText()).toEqual([sources[1]]);
  const current = [...registry.values()][0].values().next().value!;
  expect(current.startContainer.isConnected).toBe(true);
  expect(current).not.toBe(oldRange);
  await nav.focusPassages([]);
  expect(registry.size).toBe(0);
  nav.repaint();
  expect(registry.size).toBe(0);
  await nav.focusPassages(passages);
  nav.destroy();
  expect(registry.size).toBe(0);
});

it("waits for a text layer instead of displaying approximate boxes", async () => {
  page.innerHTML = "";
  await nav.focusPassages([{ blockId: block.id, sources: [sources[1]] }]);
  expect(markedText()).toEqual([]);
  expect(page.querySelector(".neoread-linked-highlight")).toBeNull();
  textLayer();
  nav.repaint();
  expect(markedText()).toEqual([sources[1]]);
});

it("anchors a repeated sentence by source offset and excludes interleaved text from another column", async () => {
  page.innerHTML =
    '<div class="textLayer"><span>Same.</span><span>Same </span><span>Other column.</span><span>sentence.</span></div>';
  const spans = page.querySelectorAll("span");
  spans.forEach((span, i) => {
    span.getBoundingClientRect = () =>
      new DOMRect(i === 2 ? 950 : 100, 100 + i * 20, 40, 15);
  });
  await nav.focusPassages([
    { blockId: block.id, sources: ["Same sentence."], sourceOffset: 5 },
  ]);
  expect(markedText()).toEqual(["Same", "sentence."]);
});

it("distinguishes identical sentences by source offset", async () => {
  page.querySelectorAll("span").forEach((span) => {
    span.textContent = "Same.";
  });
  await nav.focusPassages([
    { blockId: block.id, sources: ["Same."], sourceOffset: 5 },
  ]);
  const range = [...registry.values()][0].values().next().value!;
  expect(range.startContainer).toBe(
    page.querySelectorAll("span")[1].firstChild,
  );
  expect(markedText()).toEqual(["Same."]);
});

it("matches the three Oze sentences across PDF line fragments, italic code and a subscript", async () => {
  const lines = [
    "MVSG approach.",
    "If the transaction successfully chooses the version order, it then",
    "merges the record-local graph into the transaction-local graph after",
    "checking the follower transactions to identify the target records (",
    "𝑋",
    "𝑖",
    "defined in Section 3.1) to be merged later (Lines 6–7). The function",
    "add_target_ records()",
    " ",
    "in Lines 39–43 illustrates how a transaction",
    "identifies the target records. It first retrieves all followers (Line 40)",
    "and adds each record in the follower’s read set to the target list",
    "(Lines 41–43). Note that followers in the read phase can be ignored",
  ];
  const sentences = [
    "If the transaction successfully chooses the version order, it then merges the record-local graph into the transaction-local graph after checking the follower transactions to identify the target records ( 𝑋 𝑖 defined in Section 3.1) to be merged later (Lines 6–7).",
    "The function add_target_ records() in Lines 39–43 illustrates how a transaction identifies the target records.",
    "It first retrieves all followers (Line 40) and adds each record in the follower’s read set to the target list (Lines 41–43).",
  ];
  const layer = page.querySelector(".textLayer")!;
  layer.replaceChildren(
    ...lines.map((line, i) => {
      const span = document.createElement("span");
      span.textContent = line;
      span.getBoundingClientRect = () =>
        new DOMRect(100, 100 + i * 15, 800, 10);
      return span;
    }),
  );
  await nav.focusPassages([
    { blockId: block.id, sources: sentences, sourceOffset: 13 },
  ]);
  const normalized = (s: string) => s.replace(/\s/g, "");
  expect(markedText().map(normalized)).toEqual(sentences.map(normalized));
});

it("returns text-node fragments so sentence hover never selects PDF line breaks", () => {
  const layer = page.querySelector(".textLayer")!;
  layer.insertBefore(document.createElement("br"), layer.children[1]);
  const ranges = nav.sentenceRanges([
    { blockId: block.id, sources: [sources[1]] },
  ]);
  expect(ranges.map((r) => r.toString()).join("")).toBe(sources[1]);
  expect(ranges.length).toBeGreaterThan(1);
  for (const range of ranges) {
    expect(range.startContainer.nodeType).toBe(Node.TEXT_NODE);
    expect(range.endContainer).toBe(range.startContainer);
  }
});

it.each([false, true])("matches PDF ligatures with ligature anchors=%s, preserving sentence boundaries and DOM offsets", (ligatureAnchors) => {
  const sentences = [
    "[KMH + 20] then conducted a much more rigorous study of the scaling behavior of log loss and confirmed smooth scaling trends.",
    "In this work, we empirically test whether scaling continues to improve performance by extrapolating the previously identified phenomena another two orders of magnitude.",
    "We train a 175 billion parameter autoregressive language model, which we call GPT-3, and measure its transfer learning abilities.",
  ];
  const raw = sentences.map((s) => s.replaceAll("fi", "ﬁ"));
  const anchors = ligatureAnchors ? raw : sentences;
  currentBlock = { ...block, text: ["Before.", ...anchors].join(" ") };
  const span = page.querySelector("span")!;
  page.querySelector(".textLayer")!.replaceChildren(span);
  span.textContent = ["Before.", ...raw].join(" ");
  let sourceOffset = "Before.".length;
  for (const [i, source] of anchors.entries()) {
    const ranges = nav.sentenceRanges([
      { blockId: block.id, sources: [source], sourceOffset },
    ]);
    expect(ranges.map((r) => r.toString()).join("")).toBe(raw[i]);
    sourceOffset += source.replace(/\s/g, "").length;
  }
});
