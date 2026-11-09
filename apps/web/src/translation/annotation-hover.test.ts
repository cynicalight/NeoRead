// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Annotation } from "@neoread/core";
import { annotationsAtPoint, annotationsInRects } from "./annotation-hover";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("opens a partial EPUB mark only over the marked text", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<p data-epub-block="b">First sentence. Second sentence.</p>';
  document.body.append(host);
  const paragraph = host.firstElementChild!;
  const text = paragraph.firstChild!;
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: function (this: Range) {
      return [
        new DOMRect(
          this.startOffset * 10,
          0,
          (this.endOffset - this.startOffset) * 10,
          20,
        ),
      ];
    },
  });
  const range = document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, 5);
  const annotation = {
    id: "a",
    kind: "note",
    note: "note",
    location: { type: "epub", href: "a.xhtml" },
  } as Annotation;
  const marks = [{ annotation, range }];
  const at = (x: number) =>
    annotationsAtPoint(host, [annotation], marks, x, 10).annotations;
  expect(at(30)).toEqual([annotation]); // inside "irst" (offsets 1..5)
  expect(at(100)).toEqual([]); // same sentence, outside the mark
  expect(at(220)).toEqual([]); // next sentence
  expect(annotationsAtPoint(host, [annotation], marks, 30, 10).rects).toEqual([
    new DOMRect(10, 0, 40, 20),
  ]);
});
it("excludes bookmarks from PDF suppression", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<p data-sentence="0"></p><div class="page" data-page-number="1"></div>';
  vi.spyOn(host.lastElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 100),
  );
  const bookmark = {
    id: "a",
    kind: "bookmark",
    location: {
      type: "pdf",
      page: 1,
      rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    },
  } as Annotation;
  expect(
    annotationsInRects(host, [bookmark], [], [new DOMRect(10, 10, 20, 20)]),
  ).toEqual([]);
});
it("ignores sentences on neighbouring lines whose text boxes only touch the mark", () => {
  const host = document.createElement("div");
  host.innerHTML = '<div class="page" data-page-number="1"></div>';
  document.body.append(host);
  vi.spyOn(host.firstElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 1000),
  );
  // Lines every 20px with 24px-tall text boxes: the mark is on y = 100..124.
  const note = {
    id: "n",
    kind: "highlight",
    note: "批注",
    location: {
      type: "pdf",
      page: 1,
      rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.024 }],
    },
  } as Annotation;
  const line = (top: number, left = 100, width = 400) =>
    new DOMRect(left, top, width, 24);
  expect(annotationsInRects(host, [note], [], [line(80)])).toEqual([]);
  expect(annotationsInRects(host, [note], [], [line(120)])).toEqual([]);
  // Previous sentence ends exactly where the mark starts on the same line.
  expect(annotationsInRects(host, [note], [], [line(100, 0, 100.4)])).toEqual(
    [],
  );
  expect(annotationsInRects(host, [note], [], [line(100, 300, 50)])).toEqual([
    note,
  ]);
  expect(
    annotationsInRects(host, [note], [], [new DOMRect(150, 110, 1, 1)]),
  ).toEqual([note]);
});
