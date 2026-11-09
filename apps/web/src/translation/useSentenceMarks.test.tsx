// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Annotation,
  PDFBlock,
  EPUBReadingBlock,
  ReaderAdapter,
  SearchResult,
  TranslationBlock,
} from "@neoread/core";
// Geometry/lifecycle assertions are independent of the composited hover renderer.
vi.mock("./sentence-hover", () => ({
  SentenceHover: class {
    invalidate() {}
    show(_key: string, ranges: Range[]) {
      CSS.highlights.set("test-hover", new Highlight(...ranges));
    }
    clear() {
      CSS.highlights.delete("test-hover");
    }
    destroy() {
      this.clear();
    }
  },
}));
import { useSentenceMarks } from "./useSentenceMarks";
import { sentenceLink } from "./sentence-links";
const t: TranslationBlock = {
  blockId: "p1-b1",
  sourceHash: "hash",
  status: "complete",
  sentences: [{ source: "Original sentence.", target: "翻译句子。" }],
};
const blocks = [
  {
    id: t.blockId,
    text: "Original sentence.",
    page: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  },
] as PDFBlock[];
const epubBlocks: EPUBReadingBlock[] = [
  {
    id: t.blockId,
    text: "Original sentence.",
    label: "text",
    location: { type: "epub", href: "chapter.xhtml", locator: "{}" },
  },
];
const events = {
  location: vi.fn(),
  selection: vi.fn(),
  annotation: vi.fn(),
  annotationHover: vi.fn(),
};
let host: HTMLDivElement, root: Root;
const registry = new Map<string, Set<Range>>();
const box = (x: number) => new DOMRect(x, 0, 100, 20);
const engine = {
  sentenceRanges: () => {
    const range = document.createRange();
    range.selectNodeContents(host.querySelector("[data-source]")!.firstChild!);
    return [range];
  },
} as unknown as ReaderAdapter;
function App({
  linked = true,
  epub = false,
  reflow = false,
  annotations = [],
  translations = [t],
  searchQuery = "",
  searchResults = [],
}: {
  linked?: boolean;
  epub?: boolean;
  /** Reflowed PDF text: source and translation share one paragraph. */
  reflow?: boolean;
  annotations?: Annotation[];
  translations?: TranslationBlock[];
  searchQuery?: string;
  searchResults?: SearchResult[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSentenceMarks(
    ref,
    engine,
    epub ? epubBlocks : blocks,
    translations,
    annotations,
    linked,
    "parallel",
    events,
    searchQuery,
    searchResults,
  );
  if (reflow)
    return (
      <div ref={ref}>
        <section data-reflow-block="p1-b1">
          <div data-reflow-source="p1-b1">
            <span data-source-sentence="0">Original sentence.</span>
          </div>
          <div data-translation-block="p1-b1">
            {translations.length > 0 && <div data-sentence="0">翻译句子。</div>}
          </div>
        </section>
      </div>
    );
  return (
    <div ref={ref}>
      {epub ? (
        <div data-epub-block="p1-b1">
          <span data-epub-run="p1-b1">Original </span>
          <em>
            <span data-epub-run="p1-b1">sentence.</span>
          </em>
        </div>
      ) : (
        <div className="page" data-page-number="1">
          <div className="textLayer">
            <span data-source>Original sentence.</span>
          </div>
        </div>
      )}
      <section data-translation-block="p1-b1">
        {(!epub || translations.length > 0) && (
          <div data-sentence="0">翻译句子。</div>
        )}
      </section>
    </div>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return box(this.closest("[data-translation-block]") ? 200 : 0);
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: function (this: Range) {
      const el =
        this.startContainer.nodeType === 3
          ? this.startContainer.parentElement
          : (this.startContainer as Element);
      return [box(el?.closest("[data-translation-block]") ? 200 : 0)];
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function (this: Range) {
      return this.getClientRects()[0];
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  registry.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  events.annotation.mockClear();
  events.annotationHover.mockClear();
  window.getSelection()?.removeAllRanges();
});
const hover = () =>
  [...registry.entries()].find(([name]) => name.endsWith("-hover"))?.[1];
const texts = (ranges: Set<Range> | undefined) =>
  [...(ranges ?? [])].map((r) => r.toString());
const search = () =>
  [...registry.entries()].find(([name]) => name.endsWith("-search"))?.[1];
it("highlights only matching words in translation and clears when search changes", async () => {
  const result: SearchResult = {
    id: "p1-b1:translation:0",
    blockId: "p1-b1",
    side: "translation",
    excerpt: "翻译句子。",
    location: { type: "pdf", page: 1 },
  };
  await act(async () =>
    root.render(<App searchQuery="翻译" searchResults={[result]} />),
  );
  expect(texts(search())).toEqual(["翻译"]);
  await act(async () => root.render(<App />));
  expect(search()).toBeUndefined();
});
it("maps original search words through PDF sentence ranges", async () => {
  const result: SearchResult = {
    id: "p1-b1:source:0",
    blockId: "p1-b1",
    side: "source",
    excerpt: "Original sentence.",
    location: { type: "pdf", page: 1 },
  };
  await act(async () =>
    root.render(<App searchQuery="Original" searchResults={[result]} />),
  );
  expect(texts(search())).toEqual(["Original"]);
});
it("highlights search words in untranslated reflowed source text", async () => {
  const result: SearchResult = {
    id: "p1-b1:source:0",
    blockId: "p1-b1",
    side: "source",
    excerpt: "Original sentence.",
    location: { type: "pdf", page: 1 },
  };
  await act(async () =>
    root.render(
      <App
        reflow
        translations={[]}
        searchQuery="Original"
        searchResults={[result]}
      />,
    ),
  );
  expect(texts(search())).toEqual(["Original"]);
});
async function pointer(selector: string, type: string, x: number, buttons = 0) {
  await act(async () => {
    host.querySelector(selector)!.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: 5,
        buttons,
        button: 0,
      }),
    );
    await vi.advanceTimersByTimeAsync(125);
  });
}
it("highlights both sentence texts in either direction, clears on drag, and keeps native selection untouched", async () => {
  await act(async () => root.render(<App />));
  await pointer("[data-source]", "pointermove", 10);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  await pointer("[data-sentence]", "pointermove", 210);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  expect(window.getSelection()?.toString()).toBe("");
  await pointer("[data-sentence]", "pointerdown", 210, 1);
  expect(hover()).toBeUndefined();
});
it("keeps legacy translated marks single-sided regardless of hover association", async () => {
  const annotation: Annotation = {
    id: "a",
    documentId: "doc",
    kind: "underline",
    quote: "翻译",
    note: "note",
    color: "#5b9fe8",
    createdAt: "",
    location: {
      type: "pdf",
      page: 1,
      translation: {
        blockId: t.blockId,
        sourceHash: t.sourceHash,
        sentenceIndexes: [0],
        start: 0,
        end: 2,
      },
      sentenceLink: sentenceLink(
        [{ blockId: t.blockId, sentenceIndexes: [0] }],
        [t],
        "translation",
      ),
    },
  };
  await act(async () =>
    root.render(<App linked={false} annotations={[annotation]} />),
  );
  await pointer("[data-sentence]", "pointermove", 210);
  expect(hover()).toBeUndefined();
  expect(events.annotationHover).toHaveBeenLastCalledWith(
    expect.objectContaining({ ids: ["a"] }),
  );
  let mark = [...registry.entries()].find(([name]) =>
    name.includes("-underline-"),
  )!;
  expect(texts(mark[1])).toEqual(["翻译"]);
  await act(async () => root.render(<App annotations={[annotation]} />));
  mark = [...registry.entries()].find(([name]) =>
    name.includes("-underline-"),
  )!;
  expect(texts(mark[1])).toEqual(["翻译"]);
  expect(document.head.textContent).toContain("underline 2px #5b9fe8");
  await pointer("[data-source]", "pointermove", 10);
  expect(events.annotationHover).toHaveBeenLastCalledWith(null);
  await pointer("[data-source]", "pointerdown", 10, 1);
  await pointer("[data-source]", "click", 10);
  expect(events.annotation).not.toHaveBeenCalled();
  await pointer("[data-sentence]", "pointerdown", 210, 1);
  await pointer("[data-sentence]", "click", 210);
  expect(events.annotation).toHaveBeenCalledWith(
    expect.objectContaining({ ids: ["a"] }),
  );
  await act(async () => root.render(<App annotations={[]} />));
  expect(
    [...registry.keys()].some((name) => name.includes("-underline-")),
  ).toBe(false);
});
it("does not project legacy source notes onto translated sentences", async () => {
  const a: Annotation = {
    id: "a",
    documentId: "doc",
    kind: "note",
    quote: "Original",
    note: "note",
    color: "#6cc58c",
    createdAt: "",
    location: {
      type: "pdf",
      page: 1,
      sentenceLink: sentenceLink(
        [{ blockId: t.blockId, sentenceIndexes: [0] }],
        [t],
        "source",
      ),
    },
  };
  await act(async () => root.render(<App annotations={[a]} />));
  expect(registry.size).toBe(0);
  await act(async () =>
    root.render(
      <App
        annotations={[a]}
        translations={[{ ...t, sourceHash: "changed" }]}
      />,
    ),
  );
  expect(registry.size).toBe(0);
});

it("keeps a stationary hover after a child mutation and a parent render", async () => {
  await act(async () => root.render(<App />));
  await pointer("[data-sentence]", "pointermove", 210);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  await act(async () => {
    host.querySelector(".page")!.append(document.createElement("i"));
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  await act(async () => root.render(<App translations={[{ ...t }]} />));
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
});

it("coalesces pointer bursts and ignores block-overlay mutations without rematching PDF text", async () => {
  const matching = vi.spyOn(engine, "sentenceRanges");
  const reads = vi.spyOn(Range.prototype, "getClientRects");
  await act(async () => root.render(<App />));
  await pointer("[data-sentence]", "pointermove", 210);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
  const before = matching.mock.calls.length;
  reads.mockClear();
  await act(async () => {
    for (let i = 0; i < 30; i++)
      host.querySelector("[data-sentence]")!.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 210 + i / 100,
          clientY: 5,
        }),
      );
    await vi.advanceTimersByTimeAsync(40);
  });
  expect(reads).not.toHaveBeenCalled();
  await act(async () => {
    const overlay = document.createElement("div");
    overlay.className = "neoread-block-hover";
    host.querySelector(".page")!.append(overlay);
    await vi.advanceTimersByTimeAsync(40);
  });
  expect(matching.mock.calls.length).toBe(before);
  await act(async () => {
    host.querySelector("[data-source]")!.textContent = "Original sentence.";
    await vi.advanceTimersByTimeAsync(40);
  });
  expect(matching.mock.calls.length).toBe(before + 1);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
});

it("waits for dwell, tolerates line gaps, and cancels pending work on interruption", async () => {
  await act(async () => root.render(<App />));
  const matching = vi.spyOn(engine, "sentenceRanges");
  const send = (x: number, type = "pointermove") =>
    host
      .querySelector("[data-source]")!
      .dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: 5 }),
      );
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  send(10);
  await advance(99);
  send(10, "pointerleave");
  await advance(600);
  expect(matching).not.toHaveBeenCalled();
  expect(hover()).toBeUndefined();
  send(10);
  await advance(50);
  send(12);
  await act(async () => root.render(<App translations={[{ ...t }]} />));
  await advance(49);
  expect(matching).not.toHaveBeenCalled();
  expect(hover()).toBeUndefined();
  await advance(1);
  expect(hover()).toBeDefined();
  expect(matching).toHaveBeenCalledTimes(1);
  // Whitespace starts a single leave deadline; repeated moves do not extend it.
  send(150);
  await advance(300);
  send(160);
  await advance(199);
  expect(hover()).toBeDefined();
  send(12);
  await advance(600);
  expect(hover()).toBeDefined();
  send(150);
  await advance(499);
  expect(hover()).toBeDefined();
  await advance(1);
  expect(hover()).toBeUndefined();
  send(10);
  await advance(99);
  send(10, "pointerdown");
  await advance(600);
  expect(hover()).toBeUndefined();
  send(10);
  await advance(100);
  expect(hover()).toBeDefined();
  send(10, "scroll");
  expect(hover()).toBeUndefined();
  send(10);
  send(10, "pointerleave");
  await advance(600);
  expect(hover()).toBeUndefined();
});

it.each(["highlight", "underline", "note"] as const)(
  "opens the %s note only over the mark and hovers the rest of its sentence",
  async (kind) => {
    const annotation: Annotation = {
      id: "source-mark",
      documentId: "doc",
      kind,
      quote: "Original",
      note: "具体批注",
      color: "#e6b94c",
      createdAt: "",
      location: {
        type: "pdf",
        page: 1,
        rects: [{ x: 0, y: 0, width: 0.2, height: 1 }],
      },
    };
    const sentence = ["Original sentence.", "翻译句子。"];
    await act(async () => root.render(<App annotations={[annotation]} />));
    // The unmarked part of the same sentence behaves like any sentence.
    await pointer("[data-source]", "pointermove", 70);
    expect(texts(hover())).toEqual(sentence);
    expect(events.annotationHover).toHaveBeenLastCalledWith(null);
    // Moving onto the mark within the sentence opens its note.
    await pointer("[data-source]", "pointermove", 10);
    expect(hover()).toBeUndefined();
    expect(events.annotationHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: [annotation.id] }),
    );
    expect(events.annotation).not.toHaveBeenCalled();
    await pointer("[data-source]", "pointermove", 70);
    expect(texts(hover())).toEqual(sentence);
    expect(events.annotationHover).toHaveBeenLastCalledWith(null);
    await pointer("[data-source]", "pointerleave", 70);
    expect(events.annotationHover).toHaveBeenLastCalledWith(null);
    await pointer("[data-source]", "pointermove", 10);
    expect(events.annotationHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: [annotation.id] }),
    );
    await act(async () => root.render(<App annotations={[]} />));
    expect(texts(hover())).toEqual(sentence);
    expect(events.annotationHover).toHaveBeenLastCalledWith(null);
  },
);

it("draws split source anchors independently of translation and linking settings", async () => {
  const a: Annotation = {
    id: "split-source",
    documentId: "doc",
    kind: "highlight",
    quote: "Original sentence.",
    note: "",
    color: "#6cc58c",
    createdAt: "",
    location: {
      type: "pdf",
      page: 1,
      sourceAnchors: [
        {
          blockId: "old-layout-id",
          page: 1,
          source: "Original sentence.",
          bounds: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    },
  };
  await act(async () =>
    root.render(<App linked={false} translations={[]} annotations={[a]} />),
  );
  const mark = [...registry.entries()].find(([name]) =>
    name.includes("-highlight-"),
  );
  expect(mark).toBeDefined();
  expect(texts(mark![1])).toEqual(["Original sentence."]);
  await pointer("[data-source]", "pointermove", 10);
  expect(events.annotationHover).toHaveBeenLastCalledWith(
    expect.objectContaining({ ids: ["split-source"] }),
  );
  await pointer("[data-sentence]", "pointermove", 210);
  expect(events.annotationHover).toHaveBeenLastCalledWith(null);
});

it("links EPUB sentences across inline runs in both directions without changing selection", async () => {
  await act(async () => root.render(<App epub />));
  await pointer("[data-epub-run]", "pointermove", 5);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  await pointer("[data-sentence]", "pointermove", 205);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  expect(window.getSelection()?.toString()).toBe("");
  await pointer("[data-epub-block]", "scroll", 5);
  expect(hover()).toBeUndefined();
});
it("keeps EPUB hover on the current side when linking is disabled", async () => {
  await act(async () => root.render(<App epub linked={false} />));
  await pointer("[data-epub-run]", "pointermove", 5);
  expect(texts(hover())).toEqual(["Original sentence."]);
  await pointer("[data-sentence]", "pointermove", 205);
  expect(texts(hover())).toEqual(["翻译句子。"]);
});
it("segments untranslated EPUB source and rejects mismatched translation anchors", async () => {
  await act(async () => root.render(<App epub translations={[]} />));
  await pointer("[data-epub-run]", "pointermove", 5);
  expect(texts(hover())).toEqual(["Original sentence."]);
  await act(async () =>
    root.render(
      <App
        epub
        translations={[
          {
            ...t,
            sentences: [{ source: "Changed source.", target: "翻译句子。" }],
          },
        ]}
      />,
    ),
  );
  await pointer("[data-sentence]", "pointermove", 205);
  expect(texts(hover())).toEqual(["翻译句子。"]);
});

it("links reflowed PDF source sentences with their translations", async () => {
  await act(async () => root.render(<App reflow />));
  await pointer("[data-source-sentence]", "pointermove", 10);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  await pointer("[data-sentence]", "pointermove", 210);
  expect(texts(hover())).toEqual(["Original sentence.", "翻译句子。"]);
  await act(async () => root.render(<App reflow linked={false} />));
  await pointer("[data-source-sentence]", "pointermove", 10);
  expect(texts(hover())).toEqual(["Original sentence."]);
});
it("draws saved PDF source marks on reflowed text instead of the text layer", async () => {
  const a: Annotation = {
    id: "source",
    documentId: "doc",
    kind: "highlight",
    quote: "sentence",
    note: "",
    color: "#6cc58c",
    createdAt: "",
    location: {
      type: "pdf",
      page: 1,
      quote: "sentence",
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
    },
  };
  await act(async () =>
    root.render(<App reflow translations={[]} annotations={[a]} />),
  );
  const mark = [...registry.entries()].find(([name]) =>
    name.includes("-highlight-"),
  );
  expect(texts(mark?.[1])).toEqual(["sentence"]);
  // The marked words open their note, as in the PDF text layer.
  await pointer("[data-source-sentence]", "pointermove", 10);
  expect(events.annotationHover).toHaveBeenLastCalledWith(
    expect.objectContaining({ ids: ["source"] }),
  );
});
