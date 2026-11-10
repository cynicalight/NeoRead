// @vitest-environment jsdom
import { act, useEffect } from "react";
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
const adapter = {
  open: vi.fn(async () => {}),
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
      locator: JSON.stringify({ href: "a.xhtml", locations: {} }),
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
      locator: JSON.stringify({ href: "a.xhtml", locations: {} }),
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
      onReady(adapter, []);
    }, []);
    return (
      <div className="neoread-engine epub-web-reader">
        <section className="epub-web-chapter">
          <p data-epub-block="p1">
            <span data-epub-run="p1">First sentence. Second sentence.</span>
          </p>
          <img data-epub-block="img" alt="" />
        </section>
      </div>
    );
  },
}));
import { EPUBReadingView } from "./EPUBReadingView";
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
async function renderView(theme: ReaderTheme = reflowed) {
  await act(async () =>
    root.render(
      <EPUBReadingView
        document={{ id: "doc", type: "epub" } as Document}
        theme={theme}
        annotations={[]}
        events={events}
        onReady={() => {}}
      />,
    ),
  );
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

it("puts each translation under its source paragraph in one column", async () => {
  await renderView();
  expect(host.querySelector(".translation-panes")).toBeNull();
  expect(companion()).toBeNull();
  await click("原文译文");
  expect(companion()?.dataset.translationBlock).toBe("p1");
  expect(companion()?.textContent).toBe("第一句。第二句。");
  // Images carry no translation; their source stays visible.
  expect(host.querySelector('[data-reflow-block="img"]')).toBeNull();
  await click("仅译文");
  expect(
    host.querySelector(".epub-reflow")?.getAttribute("data-reflow-mode"),
  ).toBe("translation");
  expect(companion()?.textContent).toBe("第一句。第二句。");
  await click("仅原文");
  expect(companion()).toBeNull();
  // Turning reflow off restores the side-by-side panes.
  await renderView(defaultTheme);
  expect(host.querySelector(".translation-panes")).toBeTruthy();
});
it("keeps reading progress from the reflowed column in every mode", async () => {
  await renderView();
  await click("仅译文");
  const location = { type: "epub" as const, href: "a.xhtml", progression: 0.5 };
  await act(async () => fixture.events!.location(location, 0.5));
  expect(events.location).toHaveBeenLastCalledWith(location, 0.5);
});
it("captures translated selections inside a source paragraph", async () => {
  await renderView();
  await click("原文译文");
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
  await act(async () =>
    fixture.events!.location(
      { type: "epub", href: "a.xhtml", blockId: "p1", start: 5, end: 5 },
      0.5,
    ),
  );
  vi.mocked(adapter.followBlock!).mockClear();
  await click("仅译文");
  await act(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  expect(adapter.followBlock).toHaveBeenCalledWith({
    blockId: "p1",
    fraction: 0.5,
  });
});
