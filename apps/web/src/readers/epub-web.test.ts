// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Annotation,
  Document,
  EPUBChapter,
  EPUBLocation,
  EPUBReadingBlock,
} from "@neoread/core";
import { defaultTheme } from "@neoread/core";
import { api } from "@neoread/api";
import { EPUBReaderAdapter } from "./epub-web";
import { resolveEPUBLocation } from "./epub-web-location";

vi.mock("@neoread/api", () => ({
  api: { epubChapters: vi.fn(), epubChapter: vi.fn(), search: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../reading-links", () => ({ openExternalLink: vi.fn() }));
import { openExternalLink } from "../reading-links";
import { toast } from "sonner";

function block(
  id: string,
  text: string,
  href = "a.xhtml",
  offset = 0,
): EPUBReadingBlock {
  return {
    id,
    text,
    label: "text",
    location: {
      type: "epub",
      href,
      blockId: id,
      start: 0,
      end: text.length,
      quote: text,
      locator: JSON.stringify({
        href,
        type: "application/xhtml+xml",
        locations: { textRange: { start: offset, end: offset + text.length } },
      }),
    },
  };
}
const a = block("a", "Same words. Same words. 😀", "a.xhtml", 0);
const b = block("b", "Same words. Next sentence.", "a.xhtml", 30);
const c = block("c", "Chapter two. Only here.", "b.xhtml", 0);
const chapters: EPUBChapter[] = [
  {
    href: "a.xhtml",
    title: "第一章",
    index: 0,
    characters: a.text.length + b.text.length,
    blocks: [a, b],
  },
  {
    href: "b.xhtml",
    title: "第二章",
    index: 1,
    characters: c.text.length,
    blocks: [c],
  },
];
const html = (blocks: EPUBReadingBlock[]) =>
  blocks
    .map(
      (b) =>
        `<p id="note-${b.id}" data-epub-block="${b.id}"><span data-epub-run="${b.id}">${b.text}</span></p>`,
    )
    .join("");
let reader: EPUBReaderAdapter;
let host: HTMLDivElement;
let events: {
  location: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  selection: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  annotation: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  annotationHover: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  epubBlocksChanged: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  epubReadingAnchor: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  epubInteraction: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
};
const observers: {
  callback: IntersectionObserverCallback;
  instance: IntersectionObserver;
}[] = [];
const registry = new Map<string, Set<Range>>();
const rect = (top: number, height = 80) =>
  ({
    x: 0,
    y: top,
    left: 0,
    right: 600,
    top,
    bottom: top + height,
    width: 600,
    height,
    toJSON() {},
  }) as DOMRect;
function geometry(node: Element): DOMRect {
  if (node === host) return rect(0, 600);
  const chapter = node.closest<HTMLElement>("[data-chapter]");
  if (!chapter) return rect(0);
  let top = -host.scrollTop;
  for (const sibling of Array.from(host.children) as HTMLElement[]) {
    if (sibling === chapter) break;
    top += Number.parseFloat(sibling.style.height) || 1000;
  }
  if (node === chapter)
    return rect(top, Number.parseFloat(chapter.style.height) || 1000);
  const element = node.closest("[data-epub-block]") ?? node;
  const index = Array.from(
    chapter.querySelectorAll("[data-epub-block]"),
  ).indexOf(element);
  return rect(top + 100 + Math.max(0, index) * 100);
}
async function open(progress?: EPUBLocation) {
  reader = new EPUBReaderAdapter(host, events);
  await reader.open({ id: "book", type: "epub", progress } as Document);
  return reader;
}
function select(id: string, start: number, end: number) {
  const text = host.querySelector(`[data-epub-run="${id}"]`)!.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  host.dispatchEvent(
    new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 120 }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  registry.clear();
  observers.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  Object.defineProperty(host, "clientHeight", {
    get: () => 600,
    configurable: true,
  });
  Object.defineProperty(host, "clientWidth", { value: 800 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return geometry(this);
    },
  );
  Range.prototype.getBoundingClientRect = function () {
    return geometry(this.startContainer.parentElement!);
  };
  Range.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push({
          callback,
          instance: this as unknown as IntersectionObserver,
        });
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  events = {
    location: vi.fn(),
    selection: vi.fn(),
    annotation: vi.fn(),
    annotationHover: vi.fn(),
    epubBlocksChanged: vi.fn(),
    epubReadingAnchor: vi.fn(),
    epubInteraction: vi.fn(),
  };
  vi.mocked(api.epubChapters).mockResolvedValue({
    chapters,
    toc: [{ href: "b.xhtml#note-c", title: "第二章" }],
  });
  vi.mocked(api.epubChapter).mockImplementation(async (_id, href) => ({
    html: html(chapters.find((c) => c.href === href)!.blocks),
  }));
  vi.mocked(api.search).mockResolvedValue([
    {
      id: "hit",
      excerpt: "Same words",
      location: { type: "epub", href: "a.xhtml" },
    },
  ]);
});
afterEach(async () => {
  await reader?.destroy();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders ordered chapter placeholders, lazily inserts sanitized content without frames, and removes book IDs", async () => {
  await open();
  expect(
    Array.from(host.children).map((n) => (n as HTMLElement).dataset.chapter),
  ).toEqual(["a.xhtml", "b.xhtml"]);
  expect(api.epubChapter).toHaveBeenCalledTimes(1);
  expect(host.querySelector("iframe")).toBeNull();
  expect(host.querySelector("#note-a")).toBeNull();
  expect(host.querySelector('[data-epub-fragment="note-a"]')).not.toBeNull();
  const observer = observers[0];
  observer.callback(
    [
      {
        target: host.children[1],
        isIntersecting: true,
      } as IntersectionObserverEntry,
    ],
    observer.instance,
  );
  await vi.waitFor(() =>
    expect(host.querySelector('[data-epub-block="c"]')).not.toBeNull(),
  );
});
it("captures exact repeated text offsets and UTF-16 positions with a viewport toolbar anchor", async () => {
  await open();
  select("a", 12, 22);
  expect(reader.getSelection()).toMatchObject({
    text: "Same words",
    location: { href: "a.xhtml", blockId: "a", start: 12, end: 22 },
    anchor: { x: 40 },
  });
  select("b", 0, 10);
  expect(reader.getSelection()?.location).toMatchObject({
    blockId: "b",
    start: 0,
    end: 10,
  });
  select("a", 24, 26);
  expect(reader.getSelection()?.location).toMatchObject({ start: 24, end: 26 });
});
it("selects a whole sentence on double click and supports selections across inline markup and paragraphs", async () => {
  await open();
  select("b", 17, 25);
  host
    .querySelector('[data-epub-run="b"]')!
    .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(reader.getSelection()?.text).toBe("Next sentence.");
  const range = document.createRange();
  range.setStart(host.querySelector('[data-epub-run="a"]')!.firstChild!, 12);
  range.setEnd(host.querySelector('[data-epub-run="b"]')!.firstChild!, 10);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  host.dispatchEvent(new Event("keyup"));
  expect(reader.getSelection()?.location).toMatchObject({
    blockId: "a",
    endBlockId: "b",
    start: 12,
    end: 10,
  });
});
it("paints saved colors, opens annotation targets on hit, and removes highlights when deleted", async () => {
  await open();
  const annotation = {
    id: "mark",
    kind: "highlight",
    color: "#e6b94c",
    quote: "Same words",
    location: {
      type: "epub",
      href: "a.xhtml",
      blockId: "a",
      start: 12,
      end: 22,
    },
  } as Annotation;
  await reader.highlight([annotation]);
  expect(
    [...registry.values()].flatMap((r) => [...r]).map((r) => r.toString()),
  ).toEqual(["Same words"]);
  expect(document.head.textContent).toContain("#e6b94c66");
  const top = host
    .querySelector('[data-epub-block="a"]')!
    .getBoundingClientRect().top;
  host.dispatchEvent(
    new MouseEvent("click", { clientX: 40, clientY: top + 10, bubbles: true }),
  );
  expect(events.annotation).toHaveBeenLastCalledWith(
    expect.objectContaining({ ids: ["mark"] }),
  );
  await reader.highlight([]);
  expect(registry.size).toBe(0);
  await reader.destroy();
  await open();
  await reader.highlight([annotation]);
  expect([...registry.values()][0].values().next().value?.toString()).toBe(
    "Same words",
  );
});
it("does not paint a translated annotation on its stored source range", async () => {
  await open();
  await reader.highlight([
    {
      id: "translated",
      kind: "highlight",
      color: "#e6b94c",
      quote: "译文",
      location: {
        type: "epub",
        href: "a.xhtml",
        blockId: "a",
        start: 12,
        end: 22,
        translation: {
          blockId: "a",
          sourceHash: "h",
          sentenceIndexes: [0],
          start: 0,
          end: 2,
          ranges: [
            {
              blockId: "a",
              sourceHash: "h",
              sentenceIndexes: [0],
              start: 0,
              end: 2,
              quote: "译文",
              location: {
                type: "epub",
                href: "a.xhtml",
                blockId: "a",
                start: 12,
                end: 22,
              },
            },
          ],
        },
      },
    } as Annotation,
  ]);
  expect(registry.size).toBe(0);
});
it("restores a block location, reports progress, and returns the current chapter for AI", async () => {
  await open({ type: "epub", href: "b.xhtml", blockId: "c", start: 0, end: 0 });
  expect(api.epubChapter).toHaveBeenCalledWith(
    "book",
    "b.xhtml",
    expect.any(AbortSignal),
  );
  expect(reader.getLocation()).toMatchObject({ href: "b.xhtml", blockId: "c" });
  expect(events.location).not.toHaveBeenCalled();
  host.dispatchEvent(new Event("wheel"));
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(events.location).toHaveBeenCalled());
  expect(events.location.mock.calls.at(-1)![1]).toBeGreaterThan(0.5);
  expect(await reader.getContext()).toBe(c.text);
});
it("uses TOC and internal fragment links and delegates external URLs", async () => {
  vi.mocked(api.epubChapter).mockImplementation(async (_id, href) => ({
    html:
      html(chapters.find((c) => c.href === href)!.blocks) +
      (href === "a.xhtml"
        ? '<a href="b.xhtml#note-c">跨章</a><a href="a.xhtml#note-b">同章</a><a href="https://example.test">外链</a>'
        : ""),
  }));
  await open();
  const toc = await reader.getTOC();
  expect(toc[0].location).toEqual({ type: "epub", href: "b.xhtml#note-c" });
  (host.querySelector('a[href="a.xhtml#note-b"]') as HTMLElement).click();
  await vi.waitFor(() => expect(reader.getLocation().href).toBe("a.xhtml"));
  (host.querySelector('a[href="https://example.test"]') as HTMLElement).click();
  expect(openExternalLink).toHaveBeenCalledWith("https://example.test");
  (host.querySelector('a[href="b.xhtml#note-c"]') as HTMLElement).click();
  await vi.waitFor(() => expect(reader.getLocation().href).toBe("b.xhtml"));
  expect(host.querySelector('[data-epub-block="a"]')).not.toBeNull();
});
it("expands FTS chapter hits into exact repeated occurrences and selects the requested occurrence", async () => {
  await open();
  const results = await reader.search("Same words");
  expect(results.map((result) => result.excerpt)).toEqual([
    "Same words.",
    "Same words.",
    "Same words.",
  ]);
  expect(results.map((r) => (r.location as EPUBLocation).start)).toEqual([
    0, 12, 0,
  ]);
  expect(results.map((r) => (r.location as EPUBLocation).blockId)).toEqual([
    "a",
    "a",
    "b",
  ]);
  await reader.goTo(results[1].location);
  expect(window.getSelection()?.toString()).toBe("Same words");
  expect(reader.getSelection()?.location).toMatchObject({
    blockId: "a",
    start: 12,
    end: 22,
  });
});
it("resolves legacy offsets and unique quotes without changing stored locations, and leaves ambiguous marks unresolved", async () => {
  await open();
  const legacy: EPUBLocation = {
    type: "epub",
    href: "a.xhtml",
    quote: "Same words",
    locator: JSON.stringify({
      locations: { textRange: { start: 30, end: 40 } },
    }),
  };
  expect(resolveEPUBLocation(legacy, [a, b])).toMatchObject([
    { block: b, start: 0, end: 10 },
  ]);
  expect(
    resolveEPUBLocation({ type: "epub", href: "b.xhtml", quote: "Only here" }, [
      c,
    ]),
  ).toMatchObject([{ block: c, start: 13, end: 22 }]);
  const ambiguous: EPUBLocation = {
    type: "epub",
    href: "a.xhtml",
    quote: "Same words",
  };
  const saved = JSON.stringify(ambiguous);
  await expect(reader.goTo(ambiguous)).rejects.toThrow("未能唯一定位");
  await reader.highlight([
    {
      id: "old",
      kind: "note",
      location: ambiguous,
      quote: "Same words",
      color: "#ff0000",
    } as Annotation,
  ]);
  expect(registry.size).toBe(0);
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("已保留"));
  expect(JSON.stringify(ambiguous)).toBe(saved);
});
it("preserves a visible anchor when an earlier placeholder is replaced", async () => {
  await open({ type: "epub", href: "b.xhtml", blockId: "c", start: 0, end: 0 });
  const visible = host.querySelector('[data-epub-block="c"]')!;
  const before = visible.getBoundingClientRect().top;
  const observer = observers[0];
  observer.callback(
    [
      {
        target: host.children[0],
        isIntersecting: true,
      } as IntersectionObserverEntry,
    ],
    observer.instance,
  );
  await vi.waitFor(() =>
    expect(host.querySelector('[data-epub-block="a"]')).not.toBeNull(),
  );
  expect(visible.getBoundingClientRect().top).toBeCloseTo(before);
});
it("applies reader theme and ignores stale paginated preferences", async () => {
  await open();
  await reader.setTheme({
    ...defaultTheme,
    epubFlow: "paginated",
    fontSize: 1.4,
    fontFamily: "serif",
    lineHeight: 2,
    margin: 48,
    mode: "sepia",
  });
  expect(host.style.fontSize).toBe("1.4rem");
  expect(host.style.getPropertyValue("--epub-margin")).toBe("48px");
  expect(host.classList.contains("epub-web-reader")).toBe(true);
});

it.each(["font", "width"])(
  "preserves the visible character inside a long paragraph after %s reflow",
  async (change) => {
    const long = block("long", "x".repeat(1000));
    vi.mocked(api.epubChapters).mockResolvedValue({
      chapters: [{ ...chapters[0], blocks: [long], characters: 1000 }],
      toc: [],
    });
    vi.mocked(api.epubChapter).mockResolvedValue({ html: html([long]) });
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let columns = 20;
    const lineHeight = () =>
      (20 * (Number.parseFloat(host.style.fontSize) || defaultTheme.fontSize)) /
      defaultTheme.fontSize;
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(
      function (this: Element) {
        if (this.hasAttribute("data-epub-block"))
          return rect(
            100 - host.scrollTop,
            Math.ceil(1000 / columns) * lineHeight(),
          );
        if (this.hasAttribute("data-chapter"))
          return rect(
            -host.scrollTop,
            200 + Math.ceil(1000 / columns) * lineHeight(),
          );
        return geometry(this);
      },
    );
    Range.prototype.getBoundingClientRect = function () {
      return rect(
        100 -
          host.scrollTop +
          Math.floor(this.startOffset / columns) * lineHeight(),
        lineHeight(),
      );
    };
    await open();
    await reader.setTheme(defaultTheme);
    host.scrollTop = 505;
    host.dispatchEvent(new Event("wheel"));
    host.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(events.location).toHaveBeenCalled());
    const visible = document.createRange();
    visible.setStart(
      host.querySelector('[data-epub-run="long"]')!.firstChild!,
      400,
    );
    visible.setEnd(visible.startContainer, 401);
    const before = visible.getBoundingClientRect().top;
    expect(before).toBe(-5);

    if (change === "font") {
      await reader.setTheme({
        ...defaultTheme,
        fontSize: defaultTheme.fontSize * 2,
      });
    } else {
      columns = 10;
      resize!([], {} as ResizeObserver);
    }
    expect(visible.getBoundingClientRect().top).toBeCloseTo(before);
    expect(host.scrollTop).toBe(905);
  },
);

it("supports a selection spanning adjacent chapters and restores its exact range", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "b.xhtml" });
  const range = document.createRange();
  range.setStart(host.querySelector('[data-epub-run="b"]')!.firstChild!, 12);
  range.setEnd(host.querySelector('[data-epub-run="c"]')!.firstChild!, 11);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  host.dispatchEvent(new Event("keyup"));
  const selected = reader.getSelection()!;
  expect(selected.location).toMatchObject({
    href: "a.xhtml",
    blockId: "b",
    endBlockId: "c",
    start: 12,
    end: 11,
  });
  await reader.goTo(selected.location);
  expect(window.getSelection()?.toString()).toBe(selected.text);
});
it("keeps UTF-16 offsets correct across inline markup and trimmed block whitespace", async () => {
  vi.mocked(api.epubChapter).mockResolvedValue({
    html: '<p data-epub-block="a"><span data-epub-run="a">  Same </span><em><span data-epub-run="a">words. Same words. 😀  </span></em></p>',
  });
  await open();
  await reader.goTo({
    type: "epub",
    href: "a.xhtml",
    blockId: "a",
    start: 5,
    end: 23,
    quote: "words. Same words.",
  });
  expect(reader.getSelection()?.text).toBe("words. Same words.");
  expect(reader.getSelection()?.location).toMatchObject({ start: 5, end: 23 });
});
it("restores a legacy chapter progression without persisting a migration on open", async () => {
  await open({
    type: "epub",
    href: "b.xhtml",
    locator: JSON.stringify({ locations: { progression: 0.3 } }),
  });
  expect(reader.getLocation().href).toBe("b.xhtml");
  expect(events.location).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});
it("resolves unique legacy quotations across paragraphs with normalized whitespace", () => {
  const slices = resolveEPUBLocation(
    { type: "epub", href: "a.xhtml", quote: "words. 😀 Same words. Next" },
    [a, b],
  );
  expect(slices.map((s) => s.block.id)).toEqual(["a", "b"]);
  expect(slices.map((s) => s.block.text.slice(s.start, s.end)).join(" ")).toBe(
    "words. 😀 Same words. Next",
  );
});
it("does not install a late chapter response after destruction", async () => {
  await open();
  let finish!: (data: { html: string }) => void;
  vi.mocked(api.epubChapter).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = reader.goTo({ type: "epub", href: "b.xhtml" });
  await reader.destroy();
  finish({ html: html([c]) });
  await pending;
  expect(host.children.length).toBe(0);
  expect(registry.size).toBe(0);
});
it("retains the newest navigation when chapter responses finish out of order", async () => {
  await open();
  let finish!: (data: { html: string }) => void;
  vi.mocked(api.epubChapter).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = reader.goTo({ type: "epub", href: "b.xhtml" });
  await reader.goTo({
    type: "epub",
    href: "a.xhtml",
    blockId: "b",
    start: 0,
    end: 0,
  });
  finish({ html: html([c]) });
  await first;
  expect(reader.getLocation()).toMatchObject({ href: "a.xhtml", blockId: "b" });
});

it("selects search phrases spanning paragraphs and matches variable whitespace", async () => {
  await open();
  const results = await reader.search("😀  Same words");
  expect(results).toHaveLength(1);
  expect(results[0].location).toMatchObject({
    blockId: "a",
    start: 24,
    endBlockId: "b",
    end: 10,
  });
  await reader.goTo(results[0].location);
  expect(window.getSelection()?.toString().replace(/\s/g, "")).toBe(
    "😀Samewords",
  );
});
it("unloads distant chapter DOM into its measured height without loading every chapter", async () => {
  const many = Array.from({ length: 12 }, (_, i) => {
    const href = `chapter-${i}.xhtml`;
    return {
      href,
      title: String(i),
      index: i,
      characters: 100,
      blocks: [block(`block-${i}`, "Chapter text.", href)],
    };
  });
  vi.mocked(api.epubChapters).mockResolvedValue({
    chapters: many.map((c) => ({ ...c, blocks: [] })),
    toc: [],
  });
  vi.mocked(api.epubChapter).mockImplementation(async (_id, href) => ({
    html: html(many.find((c) => c.href === href)!.blocks),
    blocks: many.find((c) => c.href === href)!.blocks,
  }));
  await open();
  // Simulate a measured long first chapter and a distant navigation.
  for (const node of Array.from(host.children).slice(0, 11) as HTMLElement[])
    node.style.height = "1000px";
  (host.children[0] as HTMLElement).style.height = "9000px";
  await reader.goTo({ type: "epub", href: many[11].href });
  host.dispatchEvent(new Event("wheel"));
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-epub-block="block-0"]')).toBeNull(),
  );
  expect((host.children[0] as HTMLElement).style.height).toBe("9000px");
  expect(vi.mocked(api.epubChapter).mock.calls.length).toBeLessThan(12);
  expect(host.children.length).toBe(12);
  expect(
    (events.epubBlocksChanged.mock.calls.at(-1)![0] as EPUBReadingBlock[]).some(
      (b) => b.id === "block-0",
    ),
  ).toBe(false);
  // Translation-only navigation cannot rely on source scroll observers.
  vi.spyOn(host, "clientHeight", "get").mockReturnValue(0);
  await reader.goTo({ type: "epub", href: many[5].href });
  expect(
    (events.epubBlocksChanged.mock.calls.at(-1)![0] as EPUBReadingBlock[]).map(
      (b) => b.location.href,
    ),
  ).toEqual(many.slice(4, 7).map((c) => c.href));
  await reader.goTo({ type: "epub", href: many[3].href });
  expect(
    (events.epubBlocksChanged.mock.calls.at(-1)![0] as EPUBReadingBlock[]).map(
      (b) => b.location.href,
    ),
  ).toEqual(many.slice(2, 5).map((c) => c.href));
});

it("does not load all chapter placeholders when the source pane is hidden", async () => {
  await open();
  const calls = vi.mocked(api.epubChapter).mock.calls.length;
  // Hidden panes have no viewport; their resize-triggered scroll work must stop.
  Object.defineProperty(host, "getBoundingClientRect", {
    value: () => new DOMRect(),
  });
  vi.spyOn(host, "clientHeight", "get").mockReturnValue(0);
  host.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(api.epubChapter).toHaveBeenCalledTimes(calls);
});

it("reports completion at the end of the document", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "b.xhtml" });
  Object.defineProperty(host, "scrollHeight", { value: 2000 });
  host.scrollTop = 1400;
  host.dispatchEvent(new Event("wheel"));
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() =>
    expect(events.location.mock.calls.at(-1)?.[1]).toBe(1),
  );
  expect(reader.getLocation()).toMatchObject({
    href: "b.xhtml",
    blockId: "c",
    start: c.text.length,
    end: c.text.length,
    progression: 1,
  });
});

it("retains the exact block of a TOC fragment for chapter translation", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "a.xhtml#note-b" });
  expect(reader.getLocation()).toMatchObject({
    type: "epub",
    href: "a.xhtml",
    blockId: "b",
  });
});

it("keeps nested TOC anchors in their containing block", async () => {
  vi.mocked(api.epubChapter).mockImplementation(async (_id, href) => ({
    html: html(chapters.find((c) => c.href === href)!.blocks)
      .replace('id="note-a"', "")
      .replace("Same words", '<span id="nested-anchor">Same words</span>'),
  }));
  await open();
  await reader.goTo({ type: "epub", href: "a.xhtml#nested-anchor" });
  expect(reader.getLocation()).toMatchObject({ href: "a.xhtml", blockId: "a" });
});

it("emits note hover independently of selection/click and clears it on leaving", async () => {
  await open();
  const annotation = {
    id: "note",
    kind: "note",
    note: "批注内容",
    color: "#e6b94c",
    quote: "Same words",
    location: {
      type: "epub",
      href: "a.xhtml",
      blockId: "a",
      start: 0,
      end: 10,
    },
  } as Annotation;
  await reader.highlight([annotation]);
  const text = host.querySelector('[data-epub-run="a"]')!;
  const top = text.getBoundingClientRect().top;
  events.annotation.mockClear();
  events.selection.mockClear();
  text.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 40,
      clientY: top + 10,
    }),
  );
  expect(events.annotationHover).toHaveBeenLastCalledWith(
    expect.objectContaining({ ids: ["note"] }),
  );
  expect(events.annotation).not.toHaveBeenCalled();
  expect(events.selection).not.toHaveBeenCalled();
  host.dispatchEvent(new MouseEvent("pointerleave"));
  expect(events.annotationHover).toHaveBeenLastCalledWith(null);
  // Only the marked words open the note, not the rest of their sentence.
  const lineBox = text.getBoundingClientRect();
  Range.prototype.getClientRects = function (this: Range) {
    return [
      new DOMRect(
        lineBox.left + this.startOffset * 10,
        lineBox.top,
        (this.endOffset - this.startOffset) * 10,
        20,
      ),
    ] as unknown as DOMRectList;
  };
  await reader.highlight([annotation]);
  const move = (x: number) =>
    text.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: lineBox.left + x,
        clientY: lineBox.top + 10,
      }),
    );
  move(105); // "Same words|." — same sentence, outside the mark
  expect(events.annotationHover).toHaveBeenLastCalledWith(null);
  move(40);
  expect(events.annotationHover).toHaveBeenLastCalledWith(
    expect.objectContaining({ ids: ["note"] }),
  );
});

it("opens from metadata without loading distant text and resolves an unloaded search hit on demand", async () => {
  vi.mocked(api.epubChapters).mockResolvedValue({
    chapters: chapters.map((c) => ({ ...c, blocks: [] })),
    toc: [],
  });
  vi.mocked(api.epubChapter).mockImplementation(async (_id, href) => {
    const blocks = chapters.find((c) => c.href === href)!.blocks;
    return { html: html(blocks), blocks };
  });
  await open();
  expect(api.epubChapter).toHaveBeenCalledTimes(1);
  expect(await reader.getContext()).toContain(a.text);
  await reader.highlight([
    {
      id: "distant",
      kind: "highlight",
      quote: c.text,
      location: c.location,
      color: "#e6b94c",
    } as Annotation,
  ]);
  expect(toast.error).not.toHaveBeenCalled();
  vi.mocked(api.search).mockResolvedValue([
    { id: "hit", excerpt: c.text, location: { type: "epub", href: "b.xhtml" } },
  ]);
  const hits = await reader.search("Only here");
  expect(hits[0].location).toMatchObject({ href: "b.xhtml", blockId: "c" });
  expect(host.querySelector('[data-epub-block="c"]')).toBeNull();
  await reader.goTo(hits[0].location);
  expect(host.querySelector('[data-epub-block="c"]')).not.toBeNull();
});

it("loads intervening chapters when restoring a range whose endpoints are already loaded", async () => {
  const parts = Array.from({ length: 4 }, (_, i) => ({
    href: `c${i}.xhtml`,
    title: String(i),
    index: i,
    characters: 100,
    blocks: [block(`p${i}`, `Text ${i}.`, `c${i}.xhtml`)],
  }));
  vi.mocked(api.epubChapters).mockResolvedValue({
    chapters: parts.map((c) => ({ ...c, blocks: [] })),
    toc: [],
  });
  vi.mocked(api.epubChapter).mockImplementation(async (_id, href) => {
    const blocks = parts.find((c) => c.href === href)!.blocks;
    return { html: html(blocks), blocks };
  });
  await open();
  await reader.goTo({ type: "epub", href: "c3.xhtml" });
  expect(host.querySelector('[data-epub-block="p1"]')).toBeNull();
  await reader.goTo({
    type: "epub",
    href: "c0.xhtml",
    blockId: "p0",
    endBlockId: "p3",
    endHref: "c3.xhtml",
    start: 0,
    end: 7,
    quote: "Text 0.Text 1.Text 2.Text 3.",
  });
  expect(window.getSelection()?.toString()).toBe(
    "Text 0.Text 1.Text 2.Text 3.",
  );
});

it("reports the fractional EPUB reading position at the viewport midpoint", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "b.xhtml" });
  host.scrollTop = 840;
  events.epubReadingAnchor.mockClear();
  host.dispatchEvent(new Event("wheel"));
  host.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(events.epubReadingAnchor).toHaveBeenLastCalledWith("c", 0.5);
});

it("follows EPUB fractions immediately on every scroll frame", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "b.xhtml" });
  host.scrollTop = 500;
  await reader.followBlock({ blockId: "c", fraction: 0.5 });
  expect(host.scrollTop).toBeCloseTo(840);
  await reader.followBlock({ blockId: "c", fraction: 0.75 });
  expect(host.scrollTop).toBeCloseTo(862);
});

it("measures reading progress on the visible translation when reflow hides the source", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "b.xhtml" });
  // Translation-only reflow hides the source runs: their ranges have no boxes.
  Range.prototype.getBoundingClientRect = () => rect(0, 0);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  host.scrollTop = 840;
  events.location.mockClear();
  host.dispatchEvent(new Event("wheel"));
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(events.location).toHaveBeenCalled());
  // The midpoint is halfway down paragraph c, not at its end.
  expect(reader.getLocation()).toMatchObject({
    blockId: "c",
    start: Math.round(c.text.length / 2),
  });
});

it("goes to the visible translation of a paragraph whose source reflow hides", async () => {
  await open();
  await reader.goTo({ type: "epub", href: "b.xhtml" });
  const source = host.querySelector<HTMLElement>('[data-epub-block="c"]')!;
  const translation = document.createElement("div");
  translation.dataset.reflowBlock = "c";
  source.after(translation);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (
    this: Element,
  ) {
    return (this === translation ? [rect(0)] : []) as unknown as DOMRectList;
  });
  translation.getBoundingClientRect = () => rect(700);
  source.getBoundingClientRect = () => rect(0, 0);
  const before = host.scrollTop;
  await reader.goTo({
    type: "epub",
    href: "b.xhtml",
    blockId: "c",
    start: 0,
    end: 1,
  });
  // Centred on the translation at 700, not on the hidden source at 0.
  expect(host.scrollTop - before).toBe(400);
});
