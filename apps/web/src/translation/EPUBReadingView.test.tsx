// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type ReaderAdapter,
  type ReaderEvents,
  type ReaderTheme,
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
    epubBlocks: vi.fn(async () => blocks),
    assistance: vi.fn(async () => undefined),
    setAssistance: vi.fn(),
    translateEPUBChapter: vi.fn(),
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
  publicationURL: (_id: string, path: string) => `/publication/${path}`,
}));
vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
const adapter = {
  open: vi.fn(async () => {}),
  getTOC: vi.fn(async () => []),
  getLocation: () => ({ type: "epub", href: "a.xhtml" }),
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
  setEPUBBlocks: vi.fn(),
  getEPUBChapters: () =>
    ["a.xhtml", "b.xhtml"].map((href, index) => ({
      href,
      index,
      title: href,
      characters: 32,
      blocks: [],
    })),
  fitColumn: vi.fn(async () => {}),
  stopColumnFit: vi.fn(),
  followBlock: vi.fn(async () => {}),
  focusSentences: vi.fn(async () => {}),
  focusEPUBLocations: vi.fn(async () => {}),
  hoverBlock: vi.fn(),
  focusBlock: vi.fn(async () => {}),
  cancelBlockFocus: vi.fn(),
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
    useEffect(() => {
      events.epubBlocksChanged?.(blocks);
      onReady(adapter, []);
    }, []);
    return <div>EPUB 原文</div>;
  },
}));
import { useReaderStore } from "../store";
import { EPUBReadingView } from "./EPUBReadingView";
const blocks: import("@neoread/core").EPUBReadingBlock[] = [
  "a.xhtml",
  "b.xhtml",
].map((href, i) => ({
  id: i ? "e-b" : "p1-b1",
  label: "text",
  text: "First sentence. Second sentence.",
  location: {
    type: "epub",
    href,
    quote: "First sentence. Second sentence.",
    locator: JSON.stringify({
      href,
      type: "application/xhtml+xml",
      locations: {
        textRange: { start: 0, end: 32 },
        domRange: {
          start: { cssSelector: "p", textNodeIndex: 0, charOffset: 0 },
          end: { cssSelector: "p", textNodeIndex: 0, charOffset: 32 },
        },
      },
      text: { highlight: "First sentence. Second sentence." },
    }),
  },
}));
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
  vi.clearAllMocks();
  await renderView();
});
async function renderView(theme: ReaderTheme = defaultTheme) {
  await act(async () =>
    root.render(
      <EPUBReadingView
        document={{ id: "doc", type: "epub" } as Document}
        theme={theme}
        annotations={[]}
        events={events}
        onReady={(a) => {
          fixture.ready = a;
        }}
      />,
    ),
  );
}

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
}

it("supports all modes and chapter navigation without PDF page locations", async () => {
  await click("仅译文");
  expect(host.querySelector('[data-mode="translation"]')).toBeTruthy();
  vi.mocked(adapter.goTo).mockClear();
  await act(async () => fixture.ready!.next());
  expect(events.location).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "epub", href: "b.xhtml" }),
    expect.any(Number),
  );
  expect(adapter.goTo).toHaveBeenCalledWith({ type: "epub", href: "b.xhtml" });
  expect(await fixture.ready!.getContext()).toBe(blocks[1].text);
  expect(adapter.getContext).not.toHaveBeenCalled();
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(adapter.goTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "epub", href: "b.xhtml" }),
  );
});
it("keeps translated selection while source navigation emits selection resets", async () => {
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const sentence = host.querySelector('[data-sentence="1"]')!;
  const range = document.createRange();
  range.selectNodeContents(sentence);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  window.getSelection()!.addRange(range);
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  const selected = fixture.ready!.getSelection()!;
  expect(selected.location.type).toBe("epub");
  expect(selected.location.translation?.sentenceIndexes).toEqual([1]);
  await act(async () => fixture.events!.selection(null));
  expect(fixture.ready!.getSelection()).toBe(selected);
  await act(async () => fixture.ready!.clearSelection());
  expect(window.getSelection()!.rangeCount).toBe(0);
  expect(events.selection).toHaveBeenLastCalledWith(null);
});
it("restores an original interaction after following the translated pane", async () => {
  await click("仅译文");
  await click("原文译文");
  await act(async () => fixture.events!.epubInteraction?.());
  await act(async () =>
    fixture.events!.selection({
      text: "Second",
      location: {
        ...blocks[0].location,
        locator: JSON.stringify({
          locations: { textRange: { start: 16, end: 22 } },
        }),
      },
    }),
  );
  expect(
    host.querySelector('[data-sentence="0"]')?.hasAttribute("data-linked"),
  ).toBe(false);
  expect(
    host.querySelector('[data-sentence="1"]')?.hasAttribute("data-linked"),
  ).toBe(false);
});
it("keeps the translation subscription alive across modes and aborts on close", async () => {
  await click("原文译文");
  await click("仅译文");
  expect(fixture.signal?.aborted).toBe(false);
  await act(async () => root.unmount());
  expect(fixture.signal?.aborted).toBe(true);
});

it("renders successive chapters together without chapter-turn buttons", async () => {
  await click("仅译文");
  expect(
    Array.from(host.querySelectorAll("[data-chapter]")).map((n) =>
      n.getAttribute("data-chapter"),
    ),
  ).toEqual(["a.xhtml", "b.xhtml"]);
  expect(host.textContent).not.toContain("下一章");
  expect(host.textContent).not.toContain("上一章");
});

it("retains both original chapter locations when selecting across a chapter boundary", async () => {
  await act(async () =>
    fixture.push!({
      event: "snapshot",
      data: [
        ...fixture.translations,
        { ...fixture.translations[0], blockId: "e-b" },
      ],
    }),
  );
  await click("仅译文");
  const start = host.querySelector(
    '[data-chapter="a.xhtml"] [data-sentence="1"]',
  )!;
  const end = host.querySelector(
    '[data-chapter="b.xhtml"] [data-sentence="0"]',
  )!;
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.childNodes.length);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 60),
  });
  window.getSelection()!.addRange(range);
  await act(async () =>
    end.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  expect(
    fixture
      .ready!.getSelection()
      ?.location.translation?.ranges?.map((r) => r.location?.href),
  ).toEqual(["a.xhtml", "b.xhtml"]);
});

it("follows the latest translated position after an earlier chapter navigation finishes", async () => {
  await act(async () =>
    fixture.push!({
      event: "snapshot",
      data: [
        ...fixture.translations,
        { ...fixture.translations[0], blockId: "e-b" },
      ],
    }),
  );
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  vi.mocked(adapter.goTo).mockClear();
  let release!: () => void;
  vi.mocked(adapter.goTo).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const select = async (href: string) => {
    const node = host.querySelector(
      `[data-chapter="${href}"] [data-sentence="0"]`,
    )!;
    const range = document.createRange();
    range.selectNodeContents(node);
    Object.assign(range, {
      getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
    });
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () =>
      node.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
    );
  };
  await select("a.xhtml");
  await select("b.xhtml");
  expect(adapter.goTo).toHaveBeenCalledTimes(1);
  await act(async () => release());
  expect(adapter.goTo).toHaveBeenCalledTimes(2);
  expect(adapter.goTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ href: "b.xhtml" }),
  );
});

it("uses independent translation typography even when old preferences request pagination", async () => {
  await renderView({
    ...defaultTheme,
    epubFlow: "paginated",
    fontSize: 1.5,
    translationFontSize: 1.1,
    translationFontFamily: "sans-serif",
    translationFontWeight: "bold",
  });
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  expect(pane.style.fontSize).toBe("1.1rem");
  expect(pane.style.fontFamily).toBe("inherit");
  expect(pane.style.fontWeight).toBe("600");
  expect(host.querySelector(".pdf-page-navigation")).toBeNull();
});
it("keeps selection navigation without highlighting the source counterpart", async () => {
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const sentence = host.querySelector('[data-sentence="1"]')!;
  const range = document.createRange();
  range.selectNodeContents(sentence);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  window.getSelection()!.addRange(range);
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  expect(adapter.focusEPUBLocations).not.toHaveBeenCalledWith([
    expect.objectContaining({ blockId: "p1-b1", start: 16, end: 32 }),
  ]);
  expect(adapter.goTo).toHaveBeenLastCalledWith(
    expect.objectContaining({
      blockId: "p1-b1",
      start: 16,
      end: 32,
      quote: undefined,
    }),
  );
});
it("follows source block anchors and scrolls the source to the translated block in both directions", async () => {
  useReaderStore.getState().setTheme({ reducedMotion: true });
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  Object.defineProperty(pane, "clientHeight", { value: 400 });
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
  const nodes = Array.from(
    pane.querySelectorAll<HTMLElement>("[data-translation-block]"),
  );
  nodes[0].getBoundingClientRect = () => new DOMRect(0, -200, 400, 100);
  nodes[1].getBoundingClientRect = () => new DOMRect(0, 300, 400, 100);
  await act(async () => fixture.events!.epubReadingAnchor?.("e-b"));
  expect(pane.scrollTop).toBe(150);
  vi.mocked(adapter.goTo).mockClear();
  await act(async () => {
    pane.dispatchEvent(new Event("wheel", { bubbles: true }));
    pane.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(adapter.followBlock).toHaveBeenLastCalledWith({
    blockId: "e-b",
    fraction: 0,
  });
  expect(adapter.goTo).not.toHaveBeenCalled();
});

it("links block hover and focuses a clicked block in both panes", async () => {
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  Object.defineProperty(pane, "clientHeight", { value: 400 });
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
  const section = () =>
    pane.querySelector<HTMLElement>('[data-translation-block="e-b"]')!;
  section().getBoundingClientRect = () => new DOMRect(0, 600, 400, 100);
  await act(async () => fixture.events!.epubBlockHover?.("e-b"));
  expect(section().dataset.hovered).toBe("true");
  await act(async () => fixture.events!.epubBlockHover?.(null));
  expect(section().dataset.hovered).toBeUndefined();
  await act(async () =>
    section().dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
  );
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith("e-b");
  vi.mocked(adapter.goTo).mockClear();
  useReaderStore.getState().setTheme({ reducedMotion: true });
  await act(async () => fixture.events!.epubBlockFocus?.("e-b"));
  expect(adapter.focusBlock).toHaveBeenCalledWith("e-b", "parallel");
  // Centered: 600 - (400 - 100) / 2.
  expect(pane.scrollTop).toBe(450);
  expect(events.location).toHaveBeenLastCalledWith(
    expect.objectContaining({ href: "b.xhtml" }),
    expect.any(Number),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(section().dataset.focused).toBeUndefined();
  // Programmatic centering never drives the source back.
  expect(adapter.goTo).not.toHaveBeenCalled();
  await act(async () =>
    section().dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 0 }),
    ),
  );
  expect(adapter.focusBlock).toHaveBeenCalledTimes(2);
});

it("prioritizes double-click selection over translation block focus", async () => {
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const section = host.querySelector<HTMLElement>('[data-translation-block="e-b"]')!;
  vi.mocked(adapter.focusBlock!).mockClear();
  const clickBlock = (detail: number) => {
    section.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    section.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  };
  await act(async () => {
    clickBlock(1);
    clickBlock(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await act(async () => {
    clickBlock(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(adapter.focusBlock).toHaveBeenCalledWith("e-b", "parallel");
});

it("initializes chapter context in memory without saving progress on open", async () => {
  expect(fixture.ready!.getLocation()).toMatchObject({
    type: "epub",
    href: "a.xhtml",
  });
  expect(await fixture.ready!.getContext()).toBe(blocks[0].text);
  expect(events.location).not.toHaveBeenCalled();
});

it("uses only the reader's loaded blocks and subscribes only to their chapters", async () => {
  const { api } = await import("@neoread/api");
  expect(api.epubBlocks).not.toHaveBeenCalled();
  await act(async () => fixture.events!.epubBlocksChanged?.([blocks[1]]));
  expect(host.querySelector('[data-chapter="a.xhtml"]')).toBeNull();
  expect(api.translationStream).toHaveBeenLastCalledWith(
    "doc",
    expect.any(AbortSignal),
    expect.any(Function),
    ["b.xhtml"],
  );
});

it.each(["source", "translation"] as const)(
  "keeps centered EPUB blocks stable after %s focus and resumes from the viewport midpoint",
  async (origin) => {
    await click("原文译文");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    useReaderStore.getState().setTheme({ reducedMotion: true });
    const pane = host.querySelector<HTMLElement>(".translation-document")!;
    Object.defineProperty(pane, "clientHeight", { value: 400 });
    pane.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
    const nodes = Array.from(
      pane.querySelectorAll<HTMLElement>("[data-translation-block]"),
    );
    nodes[0].getBoundingClientRect = () =>
      new DOMRect(0, -300 - pane.scrollTop, 400, 100);
    nodes[1].getBoundingClientRect = () =>
      new DOMRect(0, 600 - pane.scrollTop, 400, 100);
    await act(async () => {
      if (origin === "source") fixture.events!.epubBlockFocus?.("e-b");
      else
        nodes[1].dispatchEvent(
          new MouseEvent("click", { bubbles: true, detail: 0 }),
        );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(pane.scrollTop).toBe(450);
    await act(async () => {
      fixture.events!.epubInteraction?.();
      fixture.events!.epubReadingAnchor?.("e-b");
    });
    // A centered source stays centered: there must be no jump toward the top edge.
    expect(pane.scrollTop).toBe(450);
    vi.mocked(adapter.followBlock!).mockClear();
    vi.mocked(adapter.goTo).mockClear();
    await act(async () => {
      pane.dispatchEvent(new Event("wheel", { bubbles: true }));
      pane.scrollTop += 20;
      pane.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(adapter.followBlock).toHaveBeenLastCalledWith({
      blockId: "e-b",
      fraction: 0.7,
    });
    expect(adapter.goTo).not.toHaveBeenCalled();
  },
);

it("smoothly retargets the translated midpoint and cancels following on user input", async () => {
  await click("原文译文");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  Object.defineProperty(pane, "clientHeight", { value: 400 });
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
  const node = pane.querySelector<HTMLElement>(
    '[data-translation-block="e-b"]',
  )!;
  node.getBoundingClientRect = () =>
    new DOMRect(0, 600 - pane.scrollTop, 400, 100);
  vi.useFakeTimers();
  try {
    await act(async () => {
      fixture.events!.epubInteraction?.();
      fixture.events!.epubReadingAnchor?.("e-b", 0.5);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(pane.scrollTop).toBeLessThan(450);
    await act(async () => {
      fixture.events!.epubReadingAnchor?.("e-b", 0.75);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(pane.scrollTop).toBe(475);
    await act(async () => {
      fixture.events!.epubReadingAnchor?.("e-b", 0.25);
      await vi.advanceTimersByTimeAsync(100);
      pane.dispatchEvent(new Event("wheel", { bubbles: true }));
    });
    const stopped = pane.scrollTop;
    await act(async () => {
      fixture.events!.epubReadingAnchor?.("e-b", 0.5);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(pane.scrollTop).toBe(stopped);
  } finally {
    vi.useRealTimers();
  }
});
