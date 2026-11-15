// @vitest-environment jsdom
import { act, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type EPUBReadingBlock,
  type ReaderAdapter,
  type ReaderEvents,
  type ReaderTheme,
  type TranslationBlock,
} from "@neoread/core";
const fixture = vi.hoisted(() => ({
  events: undefined as ReaderEvents | undefined,
  translations: [] as TranslationBlock[],
}));
vi.mock("@neoread/api", () => ({
  api: {
    assistance: vi.fn(async () => undefined),
    setAssistance: vi.fn(),
    translationStream: vi.fn(
      async (
        _id: string,
        signal: AbortSignal,
        onEvent: (event: {
          event: "snapshot";
          data: TranslationBlock[];
        }) => void,
      ) => {
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
const open = vi.fn(async () => {});
const adapter = {
  open,
  getTOC: vi.fn(async () => []),
  getLocation: () => ({ type: "epub", href: "a.xhtml" }),
  goTo: vi.fn(async () => {}),
  next: vi.fn(async () => {}),
  previous: vi.fn(async () => {}),
  getSelection: () => null,
  clearSelection: vi.fn(),
  highlight: vi.fn(async () => {}),
  setTheme: vi.fn(async () => {}),
  getContext: vi.fn(async () => ""),
  destroy: vi.fn(async () => {}),
  getEPUBChapters: () => [
    { href: "a.xhtml", index: 0, title: "a", characters: 64, blocks: [] },
  ],
  followBlock: vi.fn(async () => {}),
  focusEPUBLocations: vi.fn(async () => {}),
  hoverBlock: vi.fn(),
  focusBlock: vi.fn(async () => {}),
  cancelBlockFocus: vi.fn(),
} as unknown as ReaderAdapter;
const blocks: EPUBReadingBlock[] = [
  {
    id: "p1",
    label: "text",
    text: "First sentence. Second sentence.",
    location: {
      type: "epub",
      href: "a.xhtml",
    },
  },
  {
    id: "p2",
    label: "text",
    text: "New paragraph 😀.",
    location: {
      type: "epub",
      href: "a.xhtml",
      blockId: "p2",
      start: 32,
      end: 49,
    },
  },
  {
    id: "img",
    label: "image",
    text: "",
    image: "cover.png",
    location: {
      type: "epub",
      href: "a.xhtml",
    },
  },
];
// The EPUB reader's sanitized chapter DOM: block elements hold text runs.
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
      void open();
      onReady(adapter, []);
      return () => {
        void adapter.destroy();
      };
    }, []);
    return (
      <div className="neoread-engine epub-web-reader">
        <section className="epub-web-chapter">
          <p data-epub-block="p1">
            <span data-epub-run="p1">First sentence. Second sentence.</span>
          </p>
          <p data-epub-block="p2">
            <span data-epub-run="p2">New paragraph 😀.</span>
          </p>
          <img data-epub-block="img" alt="" />
        </section>
      </div>
    );
  },
}));
import { EPUBReadingView } from "./EPUBReadingView";
import type { ReadingMode } from "./reading-mode";
let root: Root, host: HTMLDivElement;
const events = { location: vi.fn(), selection: vi.fn() };
const reflowed: ReaderTheme = { ...defaultTheme, textReflow: true };
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
      blockId: "p1",
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});
function ControlledView({ theme }: { theme: ReaderTheme }) {
  const [readingMode, setReadingMode] = useState<ReadingMode>("reflow");
  const effectiveTheme = useMemo(
    () => ({ ...theme, textReflow: readingMode === "reflow" }),
    [theme, readingMode],
  );
  return (
    <EPUBReadingView
      document={{ id: "doc", type: "epub" } as Document}
      theme={effectiveTheme}
      readingMode={readingMode}
      onReadingModeChange={setReadingMode}
      annotations={[]}
      events={events}
      onReady={() => {}}
    />
  );
}
async function renderView(theme: ReaderTheme = reflowed) {
  await act(async () => root.render(<ControlledView theme={theme} />));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  )!;
  await act(async () => button.click());
}
const companion = () =>
  host.querySelector<HTMLElement>(
    'p[data-epub-block="p1"] > [data-reflow-block="p1"]',
  );

it("uses one full-width source column only for bilingual reflow", async () => {
  await renderView();
  expect(
    host.querySelector(".translation-panes")?.getAttribute("data-mode"),
  ).toBe("source");
  expect(
    host.querySelector(".epub-reflow")?.getAttribute("data-reflow-mode"),
  ).toBe("parallel");
  expect(companion()?.dataset.translationBlock).toBe("p1");
  expect(companion()?.textContent).toBe("第一句。第二句。");
  expect(host.querySelector('[data-reflow-block="img"]')).toBeNull();
  for (const [label, mode] of [
    ["原文", "source"],
    ["对照", "parallel"],
    ["译文", "translation"],
  ]) {
    await click(label);
    expect(companion()).toBeNull();
    expect(host.querySelector(".epub-reflow")).toBeNull();
    expect(
      host.querySelector(".translation-panes")?.getAttribute("data-mode"),
    ).toBe(mode);
  }
});
it("keeps reading progress from the reflowed column", async () => {
  await renderView();
  const location = { type: "epub" as const, href: "a.xhtml", progression: 0.5 };
  await act(async () => fixture.events!.location(location, 0.5));
  expect(events.location).toHaveBeenLastCalledWith(location, 0.5);
});
it("captures translated selections inside a source paragraph", async () => {
  await renderView();
  await click("重排");
  const sentence = companion()!.querySelector('[data-sentence="1"]')!;
  const range = document.createRange();
  range.selectNodeContents(sentence);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  window.getSelection()!.addRange(range);
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  expect(events.selection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      location: expect.objectContaining({
        type: "epub",
        translation: expect.objectContaining({
          blockId: "p1",
          sentenceIndexes: [1],
        }),
      }),
    }),
  );
});
it("focuses a clicked paragraph unless the setting is off", async () => {
  await renderView({ ...reflowed, blockFocus: false });
  await act(async () => fixture.events!.epubBlockFocus!("p1"));
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await renderView();
  await act(async () => fixture.events!.epubBlockFocus!("p1"));
  expect(adapter.focusBlock).toHaveBeenCalledWith("p1", "source");
});
it("centres the current paragraph after switching modes", async () => {
  await renderView();
  const flush = queuedFrames();
  await click("原文");
  await flush();
  await act(async () =>
    fixture.events!.location(
      { type: "epub", href: "a.xhtml", blockId: "p1", start: 5, end: 5 },
      0.5,
    ),
  );
  vi.mocked(adapter.followBlock!).mockClear();
  await click("重排");
  await flush();
  expect(adapter.followBlock).toHaveBeenCalledWith({
    blockId: "p1",
    fraction: 0.5,
  });
});

it.each([false, true])(
  "splits mixed reflow ranges into source and translation marks (reverse=%s)",
  async (reverse) => {
    await renderView();
    await click("重排");
    const second: EPUBReadingBlock = {
      id: "p2",
      label: "text",
      text: "Another source paragraph.",
      location: { type: "epub", href: "a.xhtml", blockId: "p2" },
    };
    const paragraph = host.querySelector<HTMLParagraphElement>(
      '[data-epub-block="p2"]',
    )!;
    paragraph.innerHTML =
      '<span data-epub-run="p2">Another source paragraph.</span>';
    await act(async () =>
      fixture.events!.epubBlocksChanged?.(
        blocks.map((block) => (block.id === second.id ? second : block)),
      ),
    );
    const first = host.querySelector('[data-epub-run="p1"]')!.firstChild!,
      last = paragraph.firstChild!.firstChild!;
    const selected = window.getSelection()!;
    selected.setBaseAndExtent(
      reverse ? last : first,
      reverse ? 7 : 6,
      reverse ? first : last,
      reverse ? 6 : 7,
    );
    Object.assign(selected.getRangeAt(0), {
      getBoundingClientRect: () => new DOMRect(0, 0, 100, 100),
    });
    await act(async () =>
      paragraph.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
    );
    const value = events.selection.mock.calls.at(-1)![0];
    expect(value.parts).toHaveLength(2);
    expect(value.parts[0]).toMatchObject({
      text: "sentence. Second sentence.\n\nAnother",
      location: { blockId: "p1", endBlockId: "p2", start: 6, end: 7 },
    });
    expect(value.parts[0].location.translation).toBeUndefined();
    expect(value.parts[1]).toMatchObject({
      text: "第一句。第二句。",
      location: {
        translation: { ranges: [{ blockId: "p1", start: 0, end: 8 }] },
      },
    });
  },
);

it("keeps a translation-starting mixed range", async () => {
  await renderView();
  await click("重排");
  const second: EPUBReadingBlock = {
    id: "p2",
    label: "text",
    text: "Another paragraph.",
    location: { type: "epub", href: "a.xhtml", blockId: "p2" },
  };
  const paragraph = host.querySelector<HTMLParagraphElement>(
    '[data-epub-block="p2"]',
  )!;
  paragraph.innerHTML = '<span data-epub-run="p2">Another paragraph.</span>';
  await act(async () =>
    fixture.events!.epubBlocksChanged?.(
      blocks.map((block) => (block.id === second.id ? second : block)),
    ),
  );
  const first = document
    .createTreeWalker(
      companion()!.querySelector('[data-sentence="0"]')!,
      NodeFilter.SHOW_TEXT,
    )
    .nextNode()!;
  const range = document.createRange();
  range.setStart(first, 2);
  range.setEnd(paragraph.firstChild!.firstChild!, 7);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 100),
  });
  window.getSelection()!.addRange(range);
  await act(async () =>
    paragraph.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  const value = events.selection.mock.calls.at(-1)![0];
  expect(value.parts.map((p: { text: string }) => p.text)).toEqual([
    "Another",
    "句。第二句。",
  ]);
  expect(value.parts[0].location).toMatchObject({
    blockId: "p2",
    start: 0,
    end: 7,
  });
});

function queuedFrames() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return async () => {
    for (let i = 0; i < 3; i++) {
      const current = [...frames.values()];
      frames.clear();
      await act(async () =>
        current.forEach((callback) => callback(performance.now())),
      );
    }
  };
}

const modeLabels = ["原文", "对照", "重排", "译文"];
it.each(
  modeLabels.flatMap((from) =>
    modeLabels.filter((to) => to !== from).map((to) => [from, to]),
  ),
)("preserves the EPUB engine and paragraph from %s to %s", async (from, to) => {
  await renderView();
  const flush = queuedFrames();
  const reader = host.querySelector(".epub-web-reader");
  const chapter = host.querySelector(".epub-web-chapter");
  expect(
    [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
  ).toEqual(modeLabels);
  await click(from);
  await flush();
  if (from === "译文") {
    const pane = host.querySelector<HTMLElement>(".translation-document")!;
    Object.defineProperty(pane, "clientHeight", { value: 400 });
    pane.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
    for (const node of pane.querySelectorAll<HTMLElement>(
      "[data-translation-block]",
    ))
      node.getBoundingClientRect = () =>
        new DOMRect(
          0,
          node.dataset.translationBlock === "p1" ? -100 : 180,
          400,
          100,
        );
    await act(async () => {
      pane.dispatchEvent(new Event("wheel", { bubbles: true }));
      pane.dispatchEvent(new Event("scroll"));
    });
    await flush();
  } else {
    await act(async () => {
      fixture.events!.epubReadingAnchor?.("p2", 0.8);
      fixture.events!.location(
        { type: "epub", href: "a.xhtml", blockId: "p1", start: 0 },
        0,
      );
    });
  }
  expect(events.location).toHaveBeenLastCalledWith(
    expect.objectContaining(blocks[1].location),
    expect.any(Number),
  );
  vi.mocked(adapter.goTo).mockClear();
  vi.mocked(adapter.followBlock!).mockClear();
  await click(to);
  await flush();
  expect(host.querySelector(".epub-web-reader")).toBe(reader);
  expect(host.querySelector(".epub-web-chapter")).toBe(chapter);
  expect(adapter.open).toHaveBeenCalledTimes(1);
  expect(adapter.destroy).not.toHaveBeenCalled();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe(to);
  if (to !== "译文") {
    expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
      blockId: "p2",
      fraction: 0.5,
    });
  } else {
    expect(adapter.followBlock).not.toHaveBeenCalled();
  }
  expect(adapter.goTo).not.toHaveBeenCalled();
});

it("cancels obsolete mode frames during rapid switching", async () => {
  await renderView();
  const flush = queuedFrames();
  const location = {
    type: "epub" as const,
    href: "a.xhtml",
    blockId: "p1",
    start: 9,
    end: 9,
  };
  await act(async () => fixture.events!.location(location, 0.5));
  await click("对照");
  await click("重排");
  await click("译文");
  await click("原文");
  await flush();
  expect(adapter.goTo).not.toHaveBeenCalled();
  expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
    blockId: "p1",
    fraction: 0.5,
  });
  expect(adapter.open).toHaveBeenCalledTimes(1);
});

it("restores a pending reflow paragraph when blocks arrive without reopening its chapter", async () => {
  await renderView();
  const flush = queuedFrames();
  await click("原文");
  await flush();
  await act(async () => {
    fixture.events!.location(
      { type: "epub", href: "a.xhtml", blockId: "p1", start: 7 },
      0.5,
    );
    fixture.events!.epubBlocksChanged?.([]);
  });
  vi.mocked(adapter.goTo).mockClear();
  vi.mocked(adapter.followBlock!).mockClear();
  await click("重排");
  await flush();
  expect(adapter.followBlock).not.toHaveBeenCalled();
  await act(async () => fixture.events!.epubBlocksChanged?.(blocks));
  await flush();
  expect(companion()?.textContent).toBe("第一句。第二句。");
  expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
    blockId: "p1",
    fraction: 0.5,
  });
  expect(adapter.goTo).not.toHaveBeenCalled();
  expect(adapter.open).toHaveBeenCalledTimes(1);
});

it.each(["原文", "对照", "译文"])(
  "retains a new reflow center paragraph through %s and back",
  async (label) => {
    await renderView();
    const flush = queuedFrames();
    const reader = host.querySelector(".epub-web-reader");
    await act(async () => {
      fixture.events!.epubReadingAnchor?.("p1");
      fixture.events!.epubReadingAnchor?.("p2", 0.9);
    });
    await click(label);
    const pane = host.querySelector<HTMLElement>(".translation-document")!;
    Object.defineProperty(pane, "clientHeight", { value: 400 });
    pane.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
    const node = pane.querySelector<HTMLElement>(
      '[data-translation-block="p2"]',
    )!;
    node.getBoundingClientRect = () =>
      new DOMRect(0, 600 - pane.scrollTop, 400, 100);
    await flush();
    if (label !== "原文") expect(pane.scrollTop).toBe(450);
    await act(async () => {
      fixture.events!.location(
        { type: "epub", href: "a.xhtml", blockId: "p1" },
        0,
      );
      if (label === "译文") {
        fixture.events!.epubInteraction?.();
        fixture.events!.epubReadingAnchor?.("p1");
      }
    });
    vi.mocked(adapter.followBlock!).mockClear();
    await click("重排");
    await flush();
    expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
      blockId: "p2",
      fraction: 0.5,
    });
    expect(host.querySelector(".epub-web-reader")).toBe(reader);
    expect(adapter.open).toHaveBeenCalledTimes(1);
  },
);

it("lets source navigation replace a pending restore before delayed blocks arrive", async () => {
  await renderView();
  const flush = queuedFrames();
  await act(async () => {
    fixture.events!.epubReadingAnchor?.("p1");
    fixture.events!.epubBlocksChanged?.([]);
  });
  await click("原文");
  await flush();
  await act(async () => {
    fixture.events!.epubInteraction?.();
    fixture.events!.epubBlocksChanged?.(blocks);
  });
  await act(async () => fixture.events!.epubReadingAnchor?.("p2"));
  await flush();
  expect(adapter.followBlock).not.toHaveBeenCalled();
  await click("重排");
  await flush();
  expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
    blockId: "p2",
    fraction: 0.5,
  });
  expect(adapter.goTo).not.toHaveBeenCalled();
});
