// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { Annotation, EPUBReadingBlock, TOCItem } from "@neoread/core";
const mocks = vi.hoisted(() => ({ chapters: vi.fn(), chapter: vi.fn() }));
vi.mock("@neoread/api", () => ({
  api: { epubChapters: mocks.chapters, epubChapter: mocks.chapter },
}));
import { epubNavigationOrders } from "./epub-navigation-order";
const block = (
  id: string,
  href: string,
  start: number,
  end: number,
): EPUBReadingBlock => ({
  id,
  label: "text",
  text: "x".repeat(end - start),
  location: {
    type: "epub",
    href,
    blockId: id,
    start: 0,
    end: end - start,
  },
});
it("uses spine order and DOM anchor offsets for same-chapter headings and bookmarks", async () => {
  mocks.chapters.mockResolvedValue({
    chapters: [
      {
        href: "z.xhtml",
        blocks: [
          block("b1", "z.xhtml", 0, 100),
          block("b2", "z.xhtml", 100, 200),
        ],
      },
      { href: "a.xhtml", blocks: [block("b3", "a.xhtml", 0, 100)] },
    ],
  });
  mocks.chapter.mockResolvedValue({
    html: '<h1 id="one"><span data-epub-run="b1">Title</span></h1><h2 id="two"><span data-epub-run="b2">Later</span></h2>',
  });
  const toc: TOCItem[] = [
    {
      id: "one",
      label: "one",
      location: { type: "epub", href: "z.xhtml#one" },
      children: [],
    },
    {
      id: "two",
      label: "two",
      location: { type: "epub", href: "z.xhtml#two" },
      children: [],
    },
    {
      id: "three",
      label: "three",
      location: { type: "epub", href: "a.xhtml" },
      children: [],
    },
  ];
  const annotations = [
    {
      id: "x",
      kind: "bookmark",
      location: { type: "epub", href: "z.xhtml", blockId: "b1", start: 50 },
    } as Annotation,
  ];
  expect(await epubNavigationOrders("d", toc, annotations)).toEqual({
    one: [0, 0],
    two: [0, 100],
    three: [1, 0],
    "bookmark:x": [0, 50],
  });
  expect(mocks.chapter).toHaveBeenCalledTimes(1);
});

it("displays a large TOC from the spine without fetching chapter bodies", async () => {
  mocks.chapter.mockClear();
  const chapters = Array.from({ length: 812 }, (_, index) => ({
    href: `c${index}.xhtml`,
    blocks: [],
  }));
  const toc: TOCItem[] = chapters.map((c, index) => ({
    id: String(index),
    label: String(index),
    location: { type: "epub", href: `${c.href}#body` },
    children: [],
  }));
  mocks.chapters.mockResolvedValue({ chapters });
  const orders = await epubNavigationOrders("large", toc, [], undefined, false);
  expect(Object.keys(orders)).toHaveLength(812);
  expect(orders["811"]).toEqual([811, 0]);
  expect(mocks.chapter).not.toHaveBeenCalled();
});
