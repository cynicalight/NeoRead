// @vitest-environment jsdom
import { copyText } from "../chat/clipboard";
import { useReaderStore } from "../store";
import { ReadingLinkNavigation } from "../reading-links";
import { act, useContext, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type PDFBlock,
  type ReaderAdapter,
  type ReaderEvents,
  type ReaderTheme,
  type SearchResult,
  type TranslationBlock,
} from "@neoread/core";
const fixture = vi.hoisted(() => ({
  events: undefined as ReaderEvents | undefined,
  ready: undefined as ReaderAdapter | undefined,
  translations: [] as TranslationBlock[],
  push: undefined as
    | ((
        event:
          | { event: "snapshot"; data: TranslationBlock[] }
          | { event: "translation"; data: TranslationBlock },
      ) => void)
    | undefined,
  signal: undefined as AbortSignal | undefined,
}));
vi.mock("@neoread/api", () => ({
  api: {
    assistance: vi.fn(async () => undefined),
    translationStream: vi.fn(
      async (
        _id: string,
        signal: AbortSignal,
        onEvent: NonNullable<typeof fixture.push>,
      ) => {
        fixture.push = onEvent;
        fixture.signal = signal;
        onEvent({ event: "snapshot", data: fixture.translations });
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    ),
    translate: vi.fn(async () => ({ queued: true })),
  },
  blockImageURL: () => "",
}));
vi.mock("../chat/clipboard", () => ({
  copyText: vi.fn(async () => true),
  copyImage: vi.fn(async () => true),
}));
vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({
    content,
    citationBlockId,
  }: {
    content: string;
    citationBlockId?: string;
  }) => {
    const navigate = useContext(ReadingLinkNavigation);
    return (
      <p>
        {content === "如图三" ? (
          <a
            href="#figure"
            onClick={(e) => {
              e.preventDefault();
              navigate?.(citationBlockId!, "figure:3");
            }}
          >
            {content}
          </a>
        ) : (
          content
        )}
      </p>
    );
  },
}));
const adapter = {
  open: vi.fn(async () => {}),
  getTOC: vi.fn(async () => []),
  getLocation: () => ({ type: "pdf", page: 1 }),
  goTo: vi.fn(async () => {}),
  next: vi.fn(async () => {}),
  previous: vi.fn(async () => {}),
  search: vi.fn(async () => []),
  getSelection: () => null,
  clearSelection: vi.fn(),
  highlight: vi.fn(async () => {}),
  setTheme: vi.fn(async () => {}),
  getContext: vi.fn(async () => ""),
  destroy: vi.fn(async () => {}),
  focusBlock: vi.fn(async () => {}),
  flashReference: vi.fn(),
  cancelBlockFocus: vi.fn(),
  followBlock: vi.fn(async () => {}),
  focusSentences: vi.fn(async () => {}),
  hoverBlock: vi.fn(),
} as unknown as ReaderAdapter;
vi.mock("../ReaderView", () => ({
  ReaderView: ({
    events,
    onReady,
  }: {
    events: ReaderEvents;
    onReady: (a: ReaderAdapter, t: []) => void;
  }) => {
    fixture.events = events;
    useEffect(() => onReady(adapter, []), []);
    return <div>PDF 原文</div>;
  },
}));
import { PDFReadingView } from "./PDFReadingView";
import { EPUBBlockOverlay } from "../readers/epub-block-focus";
let root: Root, host: HTMLDivElement;
const events = { location: vi.fn(), selection: vi.fn() };
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.translations = [
    {
      blockId: "p1-b1",
      sourceHash: "hash",
      status: "complete",
      sentences: [
        { source: "First sentence.", target: "第一句。" },
        { source: "Second sentence.", target: "第二句。" },
      ],
    },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await renderView();
});
async function renderView(
  theme: ReaderTheme = defaultTheme,
  extraBlocks: PDFBlock[] = [],
  searchResults: SearchResult[] = [],
  sidebarsOpen = { left: true, right: true },
  progress?: Document["progress"],
) {
  await act(async () =>
    root.render(
      <PDFReadingView
        sidebarsOpen={sidebarsOpen}
        document={{ id: "doc", type: "pdf", progress } as Document}
        theme={theme}
        annotations={[]}
        searchResults={searchResults}
        blocks={[
          {
            id: "p1-b1",
            page: 1,
            label: "text",
            text: "First sentence. Second sentence.",
            bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
          ...extraBlocks,
        ]}
        events={events}
        onReady={(a) => {
          fixture.ready = a;
        }}
      />,
    ),
  );
}

it("uses repaired text for search and focuses the matching block", async () => {
  const results = await fixture.ready!.search("第二句");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ blockId: "p1-b1", side: "translation" });
  await renderView(defaultTheme, [], results);
  await click("原文译文");
  expect(
    host
      .querySelector('[data-translation-block="p1-b1"]')
      ?.hasAttribute("data-search-hit"),
  ).toBe(true);
  await act(async () => fixture.ready!.focusLocation!(results[0].location));
  expect(adapter.focusBlock).toHaveBeenCalledWith("p1-b1", "parallel");
  expect(adapter.flashReference).not.toHaveBeenCalled();
});

it("retains PDF.js search on pages without parsed blocks", async () => {
  adapter.getPageCount = () => 2;
  vi.mocked(adapter.search).mockResolvedValueOnce([
    { id: "2", excerpt: "raw page", location: { type: "pdf", page: 2 } },
  ]);
  const results = await fixture.ready!.search("raw");
  expect(results).toMatchObject([
    { id: "2", location: { type: "pdf", page: 2 } },
  ]);
  delete adapter.getPageCount;
});

afterEach(async () => {
  await act(async () => root.unmount());
  useReaderStore.getState().setTheme({ reducedMotion: false });
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = Array.from(
    host.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  if (["原文译文", "仅原文", "仅译文"].includes(label) && !vi.isFakeTimers()) {
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
  }
}
it("switches modes without recreating the PDF or marking the opposite selection", async () => {
  await click("原文译文");
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await act(async () =>
    fixture.events!.selection({
      text: "Second",
      location: {
        type: "pdf",
        page: 1,
        rects: [{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }],
      },
    }),
  );
  const marked = host.querySelector('[data-sentence="1"]');
  expect(marked?.hasAttribute("data-linked")).toBe(false);
  expect(
    host.querySelector('[data-sentence="0"]')?.hasAttribute("data-linked"),
  ).toBe(false);
  await click("仅译文");
  expect(host.querySelector(".translation-source")?.hasAttribute("inert")).toBe(
    true,
  );
  await click("仅原文");
  expect(host.querySelector(".translation-document")).toBeNull();
  expect(adapter.destroy).not.toHaveBeenCalled();
});
it("keeps the translated selection and navigation metadata without marking the original", async () => {
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  await click("原文译文");
  const sentence = host.querySelector('[data-sentence="1"] p')!;
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
  );
  const range = document.createRange();
  range.selectNodeContents(sentence);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(200, 100, 80, 20),
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  expect(
    [...highlights.get("neoread-translation-selection")!][0].toString(),
  ).toBe("第二句。");
  expect(
    host
      .querySelector(".translation-document")
      ?.hasAttribute("data-compact-selection"),
  ).toBe(true);
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  expect(events.selection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: "第二句。",
      location: expect.objectContaining({
        quote: "Second sentence.",
        translation: expect.objectContaining({
          blockId: "p1-b1",
          sentenceIndexes: [1],
        }),
      }),
    }),
  );
  expect(adapter.focusSentences).not.toHaveBeenCalledWith(
    "p1-b1",
    ["Second sentence."],
    true,
  );
  const selected = fixture.ready!.getSelection()!;
  expect(selected.location.sentenceLink).toBeUndefined();
  const prepared = await fixture.ready!.prepareAnnotation!(selected);
  expect(prepared.location.translation).toEqual(selected.location.translation);
  expect(prepared.location.sentenceLink).toBeUndefined();
  await click("取消同步效果");
  vi.mocked(adapter.focusBlock!).mockClear();
  await act(async () => fixture.ready!.focusLocation!(prepared.location));
  expect(adapter.focusBlock).toHaveBeenCalledExactlyOnceWith(
    "p1-b1",
    "parallel",
  );
  await act(async () => fixture.ready!.clearSelection());
  expect(events.selection).toHaveBeenLastCalledWith(null);
  document.dispatchEvent(new Event("selectionchange"));
  expect(highlights.has("neoread-translation-selection")).toBe(false);
});
it("fits the source width on mode changes without focusing a paragraph", async () => {
  for (const label of ["原文译文", "仅译文", "原文译文", "仅原文"]) {
    vi.mocked(adapter.setTheme).mockClear();
    await click(label);
    expect(adapter.setTheme).toHaveBeenCalledWith(
      expect.objectContaining({ zoom: "width" }),
    );
    expect(adapter.focusBlock).not.toHaveBeenCalled();
  }
  vi.mocked(adapter.setTheme).mockClear();
  await renderView({ ...defaultTheme, translationFontSize: 1.2 });
  expect(adapter.setTheme).not.toHaveBeenCalled();
});

it("navigates to the matching bibliography block and restores the translated viewport fraction", async () => {
  await renderView(defaultTheme, [
    {
      id: "p9-first",
      page: 9,
      label: "text",
      text: "Before references",
      bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    },
    {
      id: "p9-ref",
      page: 9,
      label: "reference_content",
      text: "[6] Reference",
      bounds: { x: 0.1, y: 0.6, width: 0.3, height: 0.2 },
    },
  ]);
  await click("仅译文");
  const { pane } = translationGeometry();
  const reference = host.querySelector<HTMLElement>(
    '[data-translation-block="p9-ref"]',
  )!;
  reference.getBoundingClientRect = () =>
    new DOMRect(40, 1200 - pane.scrollTop, 520, 200);
  pane.scrollTop = 400;
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  const origin = fixture.ready!.getLocation();
  expect(origin).toEqual({ type: "pdf", page: 1, x: 0.1, y: 0.35 });
  await act(async () =>
    fixture.ready!.goTo({ type: "pdf", page: 9, x: 0.1, y: 0.7 }),
  );
  expect(pane.scrollTop).toBeCloseTo(1000);
  expect(fixture.ready!.isNear?.(origin)).toBe(false);
  await act(async () => fixture.ready!.goTo(origin));
  expect(pane.scrollTop).toBeCloseTo(400);
  expect(fixture.ready!.isNear?.(origin)).toBe(true);
});

it("renders an incoming paragraph while the subscription remains open", async () => {
  await click("原文译文");
  const block = fixture.translations[0];
  await act(async () =>
    fixture.push!({
      event: "snapshot",
      data: [{ ...block, status: "pending", sentences: [] }],
    }),
  );
  expect(host.textContent).toContain("正在翻译中");
  expect(host.textContent).not.toContain("优先翻译");
  await act(async () => fixture.push!({ event: "translation", data: block }));
  expect(host.textContent).toContain("第一句。");
  expect(fixture.signal!.aborted).toBe(false);
});

it("links block hover in both directions and clears it without changing sentence selections", async () => {
  await click("原文译文");
  vi.mocked(adapter.focusSentences!).mockClear();
  await act(async () =>
    fixture.events!.blockHover?.({
      id: "p1-b1",
    } as import("@neoread/core").PDFBlock),
  );
  const block = host.querySelector<HTMLElement>(
    '[data-translation-block="p1-b1"]',
  )!;
  expect(block.hasAttribute("data-hovered")).toBe(true);
  await act(async () => fixture.events!.blockHover?.(null));
  expect(block.hasAttribute("data-hovered")).toBe(false);
  await act(async () =>
    block.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith("p1-b1");
  expect(block.hasAttribute("data-hovered")).toBe(true);
  await act(async () =>
    block.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: host }),
    ),
  );
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith(null);
  expect(block.hasAttribute("data-hovered")).toBe(false);
  expect(adapter.focusSentences).not.toHaveBeenCalled();
  expect(adapter.clearSelection).not.toHaveBeenCalled();
  await act(async () =>
    block.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  await click("仅原文");
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith(null);
});

it("supports explicit block focus in source and parallel modes", async () => {
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await act(async () =>
    fixture.events!.blockFocus?.({
      id: "p1-b1",
      page: 1,
      bounds: { x: 0, y: 0 },
    } as PDFBlock),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "source");
  await click("原文译文");
  await act(async () =>
    fixture.events!.blockFocus?.({
      id: "p1-b1",
      page: 1,
      bounds: { x: 0, y: 0 },
    } as PDFBlock),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
});

it("ignores paragraph clicks when click focus is off", async () => {
  await renderView({ ...defaultTheme, blockFocus: false });
  vi.mocked(adapter.focusBlock!).mockClear();
  await act(async () =>
    fixture.events!.blockFocus?.({
      id: "p1-b1",
      page: 1,
      bounds: { x: 0, y: 0 },
    } as PDFBlock),
  );
  expect(adapter.focusBlock).not.toHaveBeenCalled();
});

it("focuses the paragraph containing a saved annotation like clicking it", async () => {
  await renderView(defaultTheme, [
    {
      id: "p1-b2",
      page: 1,
      label: "text",
      text: "Lower paragraph.",
      bounds: { x: 0.1, y: 0.55, width: 0.3, height: 0.2 },
    },
  ]);
  // Source selections store only rects; the page origin must not win.
  await act(async () =>
    fixture.ready!.focusLocation?.({
      type: "pdf",
      page: 1,
      quote: "Lower",
      rects: [{ x: 0.12, y: 0.6, width: 0.1, height: 0.02 }],
    }),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b2", "source");
  await click("原文译文");
  await act(async () =>
    fixture.ready!.focusLocation?.({
      type: "pdf",
      page: 1,
      translation: {
        blockId: "p1-b1",
        sourceHash: "hash",
        sentenceIndexes: [1],
        start: 0,
        end: 3,
      },
    }),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
  expect(adapter.goTo).not.toHaveBeenCalled();
});

it("can disable automatic original centering while reading the translation", async () => {
  await click("原文译文");
  vi.mocked(adapter.focusBlock!).mockClear();
  const centerButton = host.querySelector<HTMLButtonElement>(
    '[aria-label="取消同步效果"]',
  )!;
  expect(centerButton.getAttribute("aria-pressed")).toBe("true");
  await act(async () => centerButton.click());
  expect(
    host
      .querySelector('[aria-label="开启同步效果"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("false");
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>("[data-translation-block]")!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () => new DOMRect(0, 80, 600, 400);
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 }),
  );
  expect(pane.scrollTop).toBe(0);
  expect(host.querySelector("[data-focused]")).toBeNull();
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(adapter.followBlock).not.toHaveBeenCalled();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('[aria-label="开启同步效果"]')!
      .click();
  });
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 20 }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(adapter.followBlock).toHaveBeenLastCalledWith({
    blockId: "p1-b1",
    fraction: 0.55,
  });
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('[aria-label="取消同步效果"]')!
      .click();
  });
  const translatedBlock = host.querySelector<HTMLElement>(
    "[data-translation-block]",
  )!;
  await act(async () => {
    translatedBlock.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
});

function translationGeometry(height = 200) {
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>("[data-translation-block]")!;
  Object.defineProperties(pane, {
    clientWidth: { value: 600, configurable: true },
    clientHeight: { value: 600, configurable: true },
    scrollHeight: { value: 2400, configurable: true },
  });
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () =>
    new DOMRect(40, 600 - pane.scrollTop, 520, height);
  return { pane, block };
}
it.each([false, true])(
  "lets either scrollbar lead without wheel input or follower feedback (swapped: %s)",
  async (swapped) => {
    await click("原文译文");
    if (swapped) await click("交换原文和译文");
    const { pane } = translationGeometry();
    const source = host.querySelector<HTMLElement>(".translation-source")!;
    await act(async () => {
      pane.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      pane.scrollTop = 400;
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    // Follow while holding the translation thumb, before pointerup.
    expect(adapter.followBlock).toHaveBeenLastCalledWith({
      blockId: "p1-b1",
      fraction: 0.5,
    });
    vi.mocked(adapter.followBlock!).mockClear();
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      source.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.25 });
    });
    expect(pane.scrollTop).toBeCloseTo(350);
    await act(async () => {
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(adapter.followBlock).not.toHaveBeenCalled();
    await click("取消同步效果");
    await act(async () => {
      pane.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      pane.scrollTop = 500;
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(adapter.followBlock).not.toHaveBeenCalled();
  },
);
it("smoothly centers clicked translation blocks and follows their original without scroll feedback", async () => {
  await click("原文译文");
  const { pane, block } = translationGeometry();
  vi.useFakeTimers();
  try {
    await act(async () => block.click());
    expect(pane.scrollTop).toBe(0);
    expect(block.hasAttribute("data-focused")).toBe(true);
    expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
    const calls = vi.mocked(adapter.focusBlock!).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(pane.scrollTop).toBeLessThan(400);
    await act(async () => {
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(400);
    expect(block.hasAttribute("data-focused")).toBe(false);
    expect(adapter.focusBlock).toHaveBeenCalledTimes(calls);
    expect(adapter.followBlock).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("top-aligns tall translation blocks and cancels their motion when the user scrolls", async () => {
  await click("仅译文");
  const { pane, block } = translationGeometry(800);
  vi.useFakeTimers();
  try {
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(600);
    expect(adapter.followBlock).not.toHaveBeenCalled();
    pane.scrollTop = 0;
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    await act(async () =>
      pane.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 30 }),
      ),
    );
    pane.scrollTop = 75;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(75);
  } finally {
    vi.useRealTimers();
  }
});
it("does not treat drags, native selections or interactive controls as block navigation", async () => {
  await click("原文译文");
  const { pane, block } = translationGeometry();
  await act(async () => {
    block.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    block.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    block.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        detail: 1,
      }),
    );
  });
  const button = document.createElement("button");
  block.append(button);
  await act(async () => button.click());
  const range = document.createRange();
  range.selectNodeContents(block.querySelector("p")!);
  window.getSelection()!.addRange(range);
  await act(async () => block.click());
  expect(adapter.followBlock).not.toHaveBeenCalled();
  expect(pane.scrollTop).toBe(0);
});

it("replaces an unfinished click with an image focus and does not re-highlight on scroll", async () => {
  await renderView(defaultTheme, [
    {
      id: "p1-image",
      page: 1,
      label: "chart",
      text: "",
      image: "figure.png",
      bounds: { x: 0.55, y: 0.4, width: 0.3, height: 0.2 },
    },
  ]);
  await click("原文译文");
  const { pane, block } = translationGeometry();
  const image = pane.querySelector<HTMLElement>(
    '[data-translation-block="p1-image"]',
  )!;
  image.getBoundingClientRect = () =>
    new DOMRect(40, 1000 - pane.scrollTop, 520, 200);
  vi.useFakeTimers();
  try {
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    const before = pane.scrollTop;
    await act(async () => image.querySelector("img")!.click());
    expect(pane.scrollTop).toBe(before);
    expect(block.hasAttribute("data-focused")).toBe(false);
    expect(image.hasAttribute("data-focused")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(800);
    expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-image", "parallel");
    await act(async () => {
      host
        .querySelector(".translation-source")!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 });
    });
    expect(block.hasAttribute("data-focused")).toBe(false);
    expect(image.hasAttribute("data-focused")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("does not focus during manual scrolling and cancels keyboard focus when the pane closes", async () => {
  await click("仅译文");
  const { pane, block } = translationGeometry();
  vi.useFakeTimers();
  try {
    await act(async () => {
      pane.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 30 }),
      );
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(block.hasAttribute("data-focused")).toBe(false);
    await act(async () =>
      block.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    expect(pane.scrollTop).toBeGreaterThan(0);
    const top = pane.scrollTop;
    await click("仅原文");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(pane.scrollTop).toBe(top);
    expect(host.querySelector(".translation-document")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("centers both panels from a source click and recalculates a focused translation after resizing", async () => {
  await click("原文译文");
  const { pane, block } = translationGeometry(800);
  let width = 600,
    height = 600,
    blockHeight = 800;
  Object.defineProperties(pane, {
    clientWidth: { get: () => width, configurable: true },
    clientHeight: { get: () => height, configurable: true },
    scrollWidth: { value: 1600, configurable: true },
  });
  pane.getBoundingClientRect = () => new DOMRect(50, 20, width, height);
  block.getBoundingClientRect = () =>
    new DOMRect(150 - pane.scrollLeft, 620 - pane.scrollTop, 400, blockHeight);
  const sourceBlock = {
    id: "p1-b1",
    page: 1,
    bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
  } as PDFBlock;
  vi.useFakeTimers();
  try {
    await act(async () => fixture.events!.blockFocus?.(sourceBlock));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(600); // tall translation top, independent of short original
    expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
    await act(async () => {
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 });
      pane.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(pane.scrollTop).toBe(600); // late programmatic events cannot recenter it
    width = 400;
    height = 500;
    blockHeight = 200;
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(450);
    expect(pane.scrollLeft).toBe(100);
    expect(adapter.focusBlock).toHaveBeenCalledTimes(2);
    expect(adapter.followBlock).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "restores the reading anchor after the translation pane expands without passage focus (reduced motion: %s)",
  async (reduced) => {
    useReaderStore.getState().setTheme({ reducedMotion: reduced });
    await renderView(defaultTheme, [
      {
        id: "p1-b2",
        page: 1,
        label: "text",
        text: "Middle paragraph.",
        bounds: { x: 0.1, y: 0.55, width: 0.3, height: 0.1 },
      },
    ]);
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b2", fraction: 0.5 }),
    );
    // The resizable pane starts collapsed. Text wraps until its new width commits.
    let expanded = false,
      top = 0;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("translation-document"))
          return new DOMRect(600, 0, expanded ? 600 : 0, 600);
        if (this.dataset.translationBlock)
          return new DOMRect(
            640,
            (this.dataset.translationBlock === "p1-b2"
              ? expanded
                ? 1000
                : 6000
              : 300) - top,
            expanded ? 520 : 1,
            expanded ? 200 : 5700,
          );
        return originalRect.call(this);
      });
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(600);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(() => (expanded ? 600 : 0));
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => (expanded ? 2400 : 12000));
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollTop", "get")
      .mockImplementation(() => top);
    const setScroll = vi
      .spyOn(HTMLElement.prototype, "scrollTop", "set")
      .mockImplementation((value) => {
        top = Math.max(0, Math.min(value, expanded ? 1800 : 11400));
      });
    vi.useFakeTimers();
    try {
      await click("原文译文");
      expanded = true;
      await act(async () =>
        fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0 }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(adapter.focusBlock).not.toHaveBeenCalled();
      expect(top).toBe(800);
      expect(adapter.followBlock).toHaveBeenCalledWith({
        blockId: "p1-b2",
        fraction: 0.5,
      });
    } finally {
      vi.useRealTimers();
      for (const spy of [rect, height, width, scrollHeight, scroll, setScroll])
        spy.mockRestore();
    }
  },
);

it.each(["mode", "wheel"])(
  "cancels stale mode fitting on fresh %s input",
  async (action) => {
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 }),
    );
    vi.useFakeTimers();
    try {
      await click("原文译文");
      expect(adapter.focusBlock).not.toHaveBeenCalled();
      if (action === "mode") await click("仅原文");
      else
        await act(async () =>
          host
            .querySelector(".translation-source")!
            .dispatchEvent(
              new WheelEvent("wheel", { bubbles: true, deltaY: 50 }),
            ),
        );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(adapter.focusBlock).not.toHaveBeenCalled();
      expect(adapter.setTheme).toHaveBeenCalledTimes(action === "mode" ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("disables source following and smoothly resynchronizes from the source when enabled", async () => {
  await click("原文译文");
  const { pane } = translationGeometry();
  await click("取消同步效果");
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 }),
  );
  expect(pane.scrollTop).toBe(0);
  vi.useFakeTimers();
  try {
    await click("开启同步效果");
    expect(pane.scrollTop).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(pane.scrollTop).toBeLessThan(400);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(pane.scrollTop).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});

it("disables translation following and resynchronizes from the last manually scrolled translation", async () => {
  await click("原文译文");
  const { pane } = translationGeometry();
  await click("取消同步效果");
  vi.mocked(adapter.followBlock!).mockClear();
  vi.useFakeTimers();
  try {
    await act(async () => {
      pane.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 100 }),
      );
      pane.scrollTop = 400;
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(adapter.followBlock).not.toHaveBeenCalled();
    await click("开启同步效果");
    expect(adapter.followBlock).toHaveBeenLastCalledWith({
      blockId: "p1-b1",
      fraction: 0.5,
    });
    expect(pane.scrollTop).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["仅原文", "原文译文"])(
  "keeps annotation and search focus available with sync disabled in %s",
  async (mode) => {
    if (mode === "原文译文") await click(mode);
    await click("取消同步效果");
    vi.mocked(adapter.focusBlock!).mockClear();
    await act(async () => {
      void fixture.ready!.focusLocation?.({
        type: "pdf",
        page: 1,
        x: 0.1,
        y: 0.2,
      });
    });
    expect(adapter.focusBlock).toHaveBeenLastCalledWith(
      "p1-b1",
      mode === "仅原文" ? "source" : "parallel",
    );
    expect(
      host
        .querySelector('[aria-label="开启同步效果"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  },
);

it("focuses the image from a translated figure reference even with sync disabled", async () => {
  fixture.translations[0].sentences[0].target = "如图三";
  await renderView(defaultTheme, [
    {
      id: "figure-3",
      page: 2,
      label: "image",
      text: "",
      caption: "Figure 3. Result",
      image: "figure.png",
      bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
    },
  ]);
  await click("原文译文");
  await click("取消同步效果");
  vi.mocked(adapter.focusBlock!).mockClear();
  await act(async () =>
    host.querySelector<HTMLAnchorElement>('a[href="#figure"]')!.click(),
  );
  expect(adapter.focusBlock).toHaveBeenCalledExactlyOnceWith(
    "figure-3",
    "parallel",
  );
  expect(adapter.goTo).not.toHaveBeenCalled();
});

it("paints search and annotation jump feedback after focusing the source", async () => {
  const location = {
    type: "pdf" as const,
    page: 1,
    x: 0.1,
    y: 0.2,
    quote: "target",
  };
  vi.mocked(adapter.flashReference!).mockClear();
  await act(async () => {
    await fixture.ready!.focusLocation?.(location);
  });
  expect(adapter.flashReference).toHaveBeenCalledWith(location, "target");
});

it("paints a jump target on an unparsed page after page navigation", async () => {
  const location = { type: "pdf" as const, page: 2, quote: "unparsed target" };
  vi.mocked(adapter.flashReference!).mockClear();
  await act(async () => {
    await fixture.ready!.focusLocation?.(location);
  });
  expect(adapter.goTo).toHaveBeenCalledWith(location);
  expect(adapter.flashReference).toHaveBeenCalledWith(
    location,
    "unparsed target",
  );
});

it.each(["left", "right"] as const)(
  "lets the PDF viewport adapt to %s sidebar changes without imposing a new block zoom",
  async (closed) => {
    await click("原文译文");
    vi.mocked(adapter.focusBlock!).mockClear();
    vi.mocked(adapter.goTo).mockClear();
    await renderView(defaultTheme, [], [], {
      left: closed !== "left",
      right: closed !== "right",
    });
    await renderView();
    expect(adapter.focusBlock).not.toHaveBeenCalled();
    expect(adapter.goTo).not.toHaveBeenCalled();
  },
);

it.each(["left", "right"] as const)(
  "keeps an unparsed page in place when the %s sidebar closes",
  async (closed) => {
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 }),
    );
    const source = document.createElement("div");
    source.className = "pdf-container";
    source.innerHTML =
      '<div class="page" data-page-number="1"></div><div class="page" data-page-number="2"></div>';
    host.querySelector(".translation-source")!.append(source);
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 600, 600),
    );
    vi.spyOn(
      source.firstElementChild!,
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, -1000, 600, 1000));
    vi.mocked(adapter.focusBlock!).mockClear();
    vi.mocked(adapter.goTo).mockClear();
    vi.useFakeTimers();
    try {
      await renderView(defaultTheme, [], [], {
        left: closed !== "left",
        right: closed !== "right",
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(adapter.focusBlock).not.toHaveBeenCalled();
      expect(adapter.goTo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("strips legacy cross-side links when preparing a mark without losing its position", async () => {
  const location = {
    type: "pdf" as const,
    page: 1,
    rects: [{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }],
    sentenceLink: { origin: "source" as const, parts: [] },
  };
  const prepared = await fixture.ready!.prepareAnnotation!({
    text: "Second",
    location,
  });
  expect(prepared.location.sentenceLink).toBeUndefined();
  expect(prepared.location).toEqual({
    type: "pdf",
    page: 1,
    rects: location.rects,
  });
  await click("原文译文");
  await click("取消同步效果");
  vi.mocked(adapter.focusBlock!).mockClear();
  await act(async () => fixture.ready!.focusLocation!(prepared.location));
  expect(adapter.focusBlock).toHaveBeenCalledExactlyOnceWith(
    "p1-b1",
    "parallel",
  );
});

const reflowed = { ...defaultTheme, textReflow: true };
it("reflows source and translation paragraphs in one column for every mode", async () => {
  await renderView(reflowed);
  const sources = () =>
    Array.from(
      host.querySelectorAll(
        '[data-reflow-source="p1-b1"] [data-source-sentence]',
      ),
      (n) => n.textContent,
    );
  expect(sources()).toEqual(["First sentence. ", "Second sentence."]);
  expect(host.querySelector("[data-sentence]")).toBeNull();
  expect(host.querySelector('[aria-label="交换原文和译文"]')).toBeNull();
  expect(host.querySelector('[aria-label="取消同步效果"]')).toBeNull();
  expect(host.querySelector(".translation-source")?.hasAttribute("inert")).toBe(
    true,
  );
  await click("原文译文");
  expect(sources()).toHaveLength(2);
  // Only the translation counts as the translated block for selections.
  expect(host.querySelector("[data-translation-block]")?.textContent).toBe(
    "第一句。第二句。",
  );
  expect(host.querySelector('[aria-label="交换原文和译文"]')).toBeNull();
  await click("仅译文");
  expect(sources()).toEqual([]);
  expect(host.querySelectorAll("[data-sentence]")).toHaveLength(2);
  expect(adapter.setTheme).not.toHaveBeenCalledWith(
    expect.objectContaining({ zoom: "width" }),
  );
  expect(adapter.followBlock).not.toHaveBeenCalled();
  expect(adapter.destroy).not.toHaveBeenCalled();
});
it("selects reflowed source text as a PDF source mark", async () => {
  await renderView(reflowed);
  const sentence = host.querySelector('[data-source-sentence="1"]')!;
  const range = document.createRange();
  range.selectNodeContents(sentence);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  expect(events.selection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: "Second sentence.",
      location: {
        type: "pdf",
        page: 1,
        quote: "Second sentence.",
        sourceAnchors: [
          expect.objectContaining({
            blockId: "p1-b1",
            source: "Second sentence.",
          }),
        ],
      },
    }),
  );
  expect(fixture.ready!.getSelection()?.location).not.toHaveProperty(
    "translation",
  );
});
it("offers paragraph actions and focuses reflowed paragraphs unless disabled", async () => {
  const blockAction = vi.fn();
  Object.assign(events, { blockAction });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 40),
  );
  const focus = vi
    .spyOn(EPUBBlockOverlay.prototype, "focus")
    .mockResolvedValue(true);
  try {
    await renderView({ ...reflowed, blockFocus: false });
    const sentence = host.querySelector('[data-source-sentence="0"]')!;
    const press = async () => {
      await act(async () => {
        sentence.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        sentence.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    await act(async () =>
      sentence.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
    );
    const copy = host.querySelector<HTMLButtonElement>(
      '[data-block-action="copy"]',
    );
    expect(copy?.getAttribute("aria-label")).toBe("复制此段");
    await act(async () => copy!.click());
    // Reflowed paragraphs copy their source and translation together.
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(
      expect.any(String),
      "已复制",
    );
    expect(blockAction).not.toHaveBeenCalled();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-block-action="explain"]')!
        .click(),
    );
    expect(blockAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1-b1" }),
      "explain",
    );
    await press();
    expect(focus).not.toHaveBeenCalled();
    await renderView(reflowed);
    await press();
    expect(focus).toHaveBeenCalledWith("p1-b1");
  } finally {
    delete (events as { blockAction?: unknown }).blockAction;
  }
});
it("copies a PDF paragraph with the formulas its translation restored", async () => {
  const blockAction = vi.fn();
  Object.assign(events, { blockAction });
  try {
    await act(async () =>
      fixture.push!({
        event: "snapshot",
        data: [
          {
            blockId: "p1-b1",
            sourceHash: "hash",
            status: "complete",
            sentences: [
              {
                source: "First $x_1$.",
                anchor: "First sentence.",
                target: "第一 $x_1$。",
              },
              { source: "Second sentence.", target: "第二句。" },
            ],
          },
        ],
      } as never),
    );
    vi.mocked(copyText).mockClear();
    await act(async () =>
      fixture.events!.blockAction?.(
        {
          id: "p1-b1",
          page: 1,
          label: "text",
          text: "First sentence. Second sentence.",
          bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
        },
        "copy",
      ),
    );
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(
      "First $x_1$. Second sentence.",
      "已复制",
    );
    expect(blockAction).not.toHaveBeenCalled();
  } finally {
    delete (events as { blockAction?: unknown }).blockAction;
  }
});
it("does not move reflow text when the hidden PDF reports a position", async () => {
  await renderView(reflowed);
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>('[data-reflow-block="p1-b1"]')!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () =>
    new DOMRect(0, 1500 - pane.scrollTop, 600, 200);
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0 }),
  );
  expect(pane.scrollTop).toBe(0);
});

it("restores the saved reflow paragraph after that paragraph arrives", async () => {
  const progress = {
    type: "pdf" as const,
    page: 1,
    reflowPosition: { page: 2, blockId: "p2-b1" },
  };
  await act(async () => root.unmount());
  root = createRoot(host);
  await renderView(reflowed, [], [], undefined, progress);
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.reflowBlock === "p2-b1"
        ? new DOMRect(0, 1500 - pane.scrollTop, 600, 200)
        : new DOMRect(0, 0, 600, 600);
    });
  try {
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0 }),
    );
    expect(pane.scrollTop).toBe(0);
    await renderView(
      reflowed,
      [
        {
          id: "p2-b1",
          page: 2,
          label: "text",
          text: "Later paragraph",
          bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        },
      ],
      [],
      undefined,
      progress,
    );
    expect(pane.scrollTop).toBeCloseTo(1200);
  } finally {
    rect.mockRestore();
  }
});

it("uses the chosen margin immediately without a PDF-derived column width", async () => {
  await renderView({ ...reflowed, pdfTranslationMargin: 0 });
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  expect(pane.style.getPropertyValue("--reflow-margin")).toBe("0px");
  expect(pane.hasAttribute("data-column")).toBe(false);
  expect(pane.style.getPropertyValue("--pdf-column-width")).toBe("");
});

it("saves the visible reflow paragraph when the reader scrolls", async () => {
  await renderView(reflowed);
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>('[data-reflow-block="p1-b1"]')!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () => new DOMRect(0, 80, 600, 400);
  events.location.mockClear();
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(events.location).toHaveBeenCalledWith(
    expect.objectContaining({ type: "pdf", page: 1, reflowBlockId: "p1-b1" }),
    expect.any(Number),
  );
});

it("returns to the latest reflow paragraph after switching modes or tabs", async () => {
  const later = {
    id: "p1-b2",
    page: 1,
    label: "text",
    text: "Later",
    bounds: { x: 0.1, y: 0.7, width: 0.3, height: 0.1 },
  };
  const progress = {
    type: "pdf" as const,
    page: 1,
    reflowPosition: { page: 1, blockId: "p1-b1" },
  };
  await act(async () => root.unmount());
  root = createRoot(host);
  await renderView(reflowed, [later], [], undefined, progress);
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  const node = pane.querySelector<HTMLElement>('[data-reflow-block="p1-b2"]')!;
  node.getBoundingClientRect = () =>
    new DOMRect(0, 1200 - pane.scrollTop, 600, 200);
  vi.mocked(adapter.goTo).mockClear();
  await act(async () =>
    fixture.ready!.goTo({ type: "pdf", page: 1, reflowBlockId: "p1-b2" }),
  );
  expect(pane.scrollTop).toBe(900);
  expect(adapter.goTo).not.toHaveBeenCalled();
  await renderView(defaultTheme, [later], [], undefined, progress);
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("translation-document"))
        return new DOMRect(0, 0, 600, 600);
      if (this.dataset.reflowBlock === "p1-b2")
        return new DOMRect(
          0,
          1200 -
            (this.closest<HTMLElement>(".translation-document")?.scrollTop ??
              0),
          600,
          200,
        );
      return new DOMRect(0, 0, 600, 200);
    });
  try {
    await renderView(reflowed, [later], [], undefined, progress);
    const restored = host.querySelector<HTMLElement>(".translation-document")!;
    expect(restored.scrollTop).toBe(900);
  } finally {
    rect.mockRestore();
  }
  expect(events.location).toHaveBeenCalledWith(
    expect.objectContaining({ reflowBlockId: "p1-b2" }),
    expect.any(Number),
  );
});

it("restores the non-reflow translation position after reading elsewhere in reflow", async () => {
  const later = {
    id: "p1-b2",
    page: 1,
    label: "text",
    text: "Later",
    bounds: { x: 0.1, y: 0.7, width: 0.3, height: 0.1 },
  };
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("translation-document"))
        return new DOMRect(0, 0, 600, 600);
      const id = this.dataset.reflowBlock ?? this.dataset.translationBlock;
      if (id)
        return new DOMRect(
          0,
          (id === "p1-b1" ? 700 : 1500) -
            (this.closest<HTMLElement>(".translation-document")?.scrollTop ??
              0),
          600,
          200,
        );
      return new DOMRect(0, 0, 600, 200);
    });
  try {
    await renderView(defaultTheme, [later]);
    await click("仅译文");
    await act(async () =>
      fixture.ready!.goTo({ type: "pdf", page: 1, x: 0.1, y: 0.2 }),
    );
    await renderView(reflowed, [later]);
    await act(async () =>
      fixture.ready!.goTo({ type: "pdf", page: 1, reflowBlockId: "p1-b2" }),
    );
    await renderView(defaultTheme, [later]);
    expect(
      host.querySelector<HTMLElement>(".translation-document")!.scrollTop,
    ).toBe(400);
  } finally {
    rect.mockRestore();
  }
});

it("starts a first reflow session at its own first page, independently of the PDF", async () => {
  const later = {
    id: "p4-b1",
    page: 4,
    label: "text",
    text: "Later",
    bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
  };
  const next = { ...later, id: "p2-b1", page: 2 };
  await renderView(defaultTheme, [next, later]);
  await act(async () =>
    fixture.ready!.goTo({ type: "pdf", page: 4, x: 0.1, y: 0.2 }),
  );
  await renderView(reflowed, [next, later]);
  expect(fixture.ready!.getLocation()).toMatchObject({
    type: "pdf",
    page: 1,
    reflowBlockId: "p1-b1",
  });
  await act(async () => fixture.ready!.next());
  expect(events.location).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 2, reflowBlockId: "p2-b1" }),
    expect.any(Number),
  );
});
