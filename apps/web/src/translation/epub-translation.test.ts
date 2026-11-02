// @vitest-environment jsdom
import { expect, it } from "vitest";
import type {
  EPUBReadingBlock,
  TranslationBlock,
  Annotation,
} from "@neoread/core";
import { Locator } from "@readium/shared";
import {
  selectionLocator,
  resolveEPUBRange,
  sliceEPUBRange,
} from "../readers/selection-locator";
import {
  epubSentenceLocation,
  epubSentenceSlice,
  epubBlocksAt,
  epubOffsets,
} from "./epub-links";
import { translatedSelection } from "./selection";
import { translatedAnnotationRanges } from "./annotations";
function blocks() {
  const doc = new DOMParser().parseFromString(
    "<body><p>Repeat. <b>😀 second.</b></p><p>Repeat. <b>😀 second.</b></p></body>",
    "text/html",
  );
  return [...doc.querySelectorAll("p")].map((node, i) => {
    const range = doc.createRange();
    range.selectNodeContents(node);
    const locator = selectionLocator(
      Locator.deserialize({
        href: "chapter.xhtml",
        type: "application/xhtml+xml",
      })!,
      range,
    )!;
    return {
      id: `e-${i}`,
      text: range.toString(),
      label: "text",
      location: {
        type: "epub",
        href: "chapter.xhtml",
        quote: range.toString(),
        locator: JSON.stringify(locator.serialize()),
      },
    } satisfies EPUBReadingBlock;
  });
}
it("keeps repeated EPUB paragraphs distinct and links only the selected sentence", () => {
  const input = blocks();
  const location = epubSentenceLocation(
    input[1],
    [{ source: "Repeat." }, { source: "😀 second." }],
    [1],
  );
  expect(epubBlocksAt(location, input).map((b) => b.id)).toEqual(["e-1"]);
  expect(epubOffsets(location)!.start).toBe(
    epubOffsets(input[1].location)!.start + 8,
  );
  const doc = new DOMParser().parseFromString(
    "<body><p>Repeat. <b>😀 second.</b></p><p>Repeat. <b>😀 second.</b></p></body>",
    "text/html",
  );
  const locator = Locator.deserialize(JSON.parse(location.locator!))!;
  const range = resolveEPUBRange(doc, locator)!;
  const slice = locator.locations.otherLocations!.get("sourceSlice") as {
    start: number;
    end: number;
  };
  const chosen = sliceEPUBRange(range, slice.start, slice.end)!;
  expect(chosen.toString()).toBe("😀 second.");
  expect(chosen.startContainer.parentElement!.closest("p")).toBe(
    doc.querySelectorAll("p")[1],
  );
});
it("persists cross-paragraph translated marks and rejects stale source versions", () => {
  const input = blocks();
  const translations: TranslationBlock[] = input.map((b) => ({
    blockId: b.id,
    sourceHash: b.id,
    status: "complete",
    sentences: [
      { source: "Repeat.", target: "重复。" },
      { source: "😀 second.", target: "😀 第二句。" },
    ],
  }));
  const host = document.createElement("div");
  host.innerHTML = input
    .map(
      (b) =>
        `<section data-translation-block="${b.id}"><span data-sentence="0">重复。</span><span data-sentence="1">😀 第二句。</span></section>`,
    )
    .join("");
  const nodes = host.querySelectorAll("span");
  const range = document.createRange();
  range.setStart(nodes[1].firstChild!, 0);
  range.setEnd(nodes[2].firstChild!, 3);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 20),
  });
  const selected = translatedSelection(
    host,
    range,
    input,
    translations,
  )!.selection;
  expect(selected.location.type).toBe("epub");
  expect(selected.location).not.toHaveProperty("page");
  expect(
    selected.location.translation!.ranges!.map((r) => r.location?.href),
  ).toEqual(["chapter.xhtml", "chapter.xhtml"]);
  const note = JSON.parse(
    JSON.stringify({
      id: "note",
      documentId: "book",
      kind: "underline",
      quote: selected.text,
      note: "笔记",
      color: "#e6b94c",
      createdAt: "",
      location: selected.location,
    }),
  ) as Annotation;
  expect(
    translatedAnnotationRanges(host, [note], translations).map((r) =>
      r.range.toString(),
    ),
  ).toEqual(["😀 第二句。", "重复。"]);
  expect(
    translatedAnnotationRanges(
      host,
      [note],
      translations.map((t) => ({ ...t, sourceHash: "new" })),
    ),
  ).toEqual([]);
  expect(translatedAnnotationRanges(host, [], translations)).toEqual([]);
});

it("resolves repeated sentences by UTF-16 offset without a legacy locator", () => {
  const block: EPUBReadingBlock = {
    id: "repeat",
    label: "text",
    text: "Repeat.  😀 Repeat.",
    location: { type: "epub", href: "chapter.xhtml", start: 0, end: 19 },
  };
  const slice = epubSentenceSlice(
    block,
    [{ source: "Repeat." }, { source: "😀 Repeat." }],
    [1],
  );
  expect(slice).toEqual({ start: 9, end: 19 });
  expect(block.text.slice(slice!.start, slice!.end)).toBe("😀 Repeat.");
  expect(
    epubSentenceSlice(block, [{ source: "Changed text." }], [0]),
  ).toBeUndefined();
});
