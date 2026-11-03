// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
vi.mock("pdfjs-dist", () => ({
  Util: { transform: (_a: number[], b: number[]) => b },
}));
import { PDFReadingNavigation } from "./pdf-navigation";

it("uses selected glyph positions to distinguish repeated words and includes both paragraphs", async () => {
  const host = document.createElement("div"),
    page = document.createElement("div");
  host.append(page);
  page.innerHTML =
    '<div class="textLayer"><span>The model works. </span><span>The model works.</span><span>Next paragraph.</span></div>';
  const spans = page.querySelectorAll("span");
  page.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 1000);
  spans.forEach((s, i) => {
    s.getBoundingClientRect = () => new DOMRect(100, 100 + i * 30, 300, 20);
  });
  const old = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function () {
    const index = Array.from(spans).indexOf(
      this.startContainer.parentElement as HTMLSpanElement,
    );
    return [
      new DOMRect(100, 100 + index * 30, 300, 20),
    ] as unknown as DOMRectList;
  };
  try {
    const blocks: PDFBlock[] = [
      {
        id: "a",
        page: 1,
        label: "text",
        text: "The model works. The model works.",
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.06 },
      },
      {
        id: "b",
        page: 1,
        label: "text",
        text: "Next paragraph.",
        bounds: { x: 0.1, y: 0.16, width: 0.3, height: 0.03 },
      },
    ];
    const translations: TranslationBlock[] = [
      {
        blockId: "a",
        sourceHash: "a",
        status: "complete",
        sentences: [
          { source: "The model works.", target: "模型有效。" },
          { source: "The model works.", target: "模型有效。" },
        ],
      },
      {
        blockId: "b",
        sourceHash: "b",
        status: "complete",
        sentences: [{ source: "Next paragraph.", target: "下一段。" }],
      },
    ];
    const nav = new PDFReadingNavigation(
      host,
      { getPageView: () => ({ div: page }) } as unknown as PDFViewer,
      async () =>
        ({
          getViewport: () => ({ width: 1000, height: 1000, transform: [] }),
          getTextContent: async () => ({ items: [], styles: {} }),
        }) as unknown as PDFPageProxy,
      () => blocks,
      { location: vi.fn(), selection: vi.fn() },
    );
    expect(
      await nav.matchSentences(
        {
          type: "pdf",
          page: 1,
          rects: [{ x: 0.15, y: 0.105, width: 0.05, height: 0.01 }],
        },
        translations,
      ),
    ).toEqual([{ blockId: "a", sentenceIndexes: [0] }]);
    expect(
      await nav.matchSentences(
        {
          type: "pdf",
          page: 1,
          rects: [
            { x: 0.15, y: 0.135, width: 0.05, height: 0.01 },
            { x: 0.15, y: 0.165, width: 0.05, height: 0.01 },
          ],
        },
        translations,
      ),
    ).toEqual([
      { blockId: "a", sentenceIndexes: [1] },
      { blockId: "b", sentenceIndexes: [0] },
    ]);
    await nav.focusPassages([
      { blockId: "a", sources: ["The model works."], sourceOffset: 14 },
    ]);
    // Sentence focusing is exercised through native highlight ranges in
    // pdf-sentence-highlights.test.ts; it no longer appends page rectangles.
    expect(page.querySelector(".neoread-linked-highlight")).toBeNull();
    nav.destroy();
  } finally {
    Range.prototype.getClientRects = old;
  }
});

it("cancels an in-flight page move on pointer input without reporting the destination as reached", async () => {
  const host = document.createElement("div"),
    node = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  node.getBoundingClientRect = () =>
    new DOMRect(0, 1200 - host.scrollTop, 800, 1000);
  const nav = new PDFReadingNavigation(
    host,
    { getPageView: () => ({ div: node, pdfPage: {} }) } as unknown as PDFViewer,
    vi.fn(),
    () => [],
    { location: vi.fn(), selection: vi.fn() },
  );
  try {
    const pending = nav.goTo(2);
    await vi.waitFor(() => expect(host.scrollTop).toBeGreaterThan(0));
    expect(host.scrollTop).toBeLessThan(1176);
    host.dispatchEvent(new MouseEvent("pointerdown"));
    host.scrollTop = 42;
    expect(await pending).toBe(false);
    expect(host.scrollTop).toBe(42);
    expect(await nav.goTo(2)).toBe(true);
    expect(host.scrollTop).toBe(1176);
  } finally {
    nav.destroy();
  }
});

it.each(["restore", "follow"])(
  "initializes only a lazy destination's real dimensions before %s",
  async (action) => {
    vi.useFakeTimers();
    const host = document.createElement("div"),
      node = document.createElement("div");
    Object.defineProperties(host, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 6000 },
    });
    host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    const proxy = {
      getViewport: () => ({ width: 800, height: 1400 }),
    } as PDFPageProxy;
    const view = {
      div: node,
      pdfPage: undefined as PDFPageProxy | undefined,
      setPdfPage(value: PDFPageProxy) {
        this.pdfPage = value;
      },
    };
    node.getBoundingClientRect = () =>
      new DOMRect(0, 1200 - host.scrollTop, 800, view.pdfPage ? 1400 : 1000);
    const load = vi.fn(async () => proxy);
    const nav = new PDFReadingNavigation(
      host,
      {
        getPageView: (index: number) => (index === 1 ? view : undefined),
      } as unknown as PDFViewer,
      load,
      () => [
        {
          id: "later",
          page: 2,
          label: "paragraph",
          text: "later",
          bounds: { x: 0, y: 0.2, width: 1, height: 0.2 },
        },
      ],
      { location: vi.fn(), selection: vi.fn() },
    );
    try {
      const moving =
        action === "restore"
          ? nav.goTo(2, { x: 0, y: 0.3 })
          : nav.follow({ blockId: "later", fraction: 0.5 });
      await vi.advanceTimersByTimeAsync(500);
      await moving;
      expect(load).toHaveBeenCalledExactlyOnceWith(2);
      expect(view.pdfPage).toBe(proxy);
      expect(host.scrollTop).toBeCloseTo(action === "restore" ? 1596 : 1320);
      const position = host.scrollTop;
      view.pdfPage = undefined;
      let complete!: (page: PDFPageProxy) => void;
      load.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const cancelled =
        action === "restore"
          ? nav.goTo(2)
          : nav.follow({ blockId: "later", fraction: 0 });
      host.dispatchEvent(new MouseEvent("pointerdown"));
      complete(proxy);
      await cancelled;
      expect(view.pdfPage).toBeUndefined();
      expect(host.scrollTop).toBe(position);
    } finally {
      nav.destroy();
      vi.useRealTimers();
    }
  },
);
