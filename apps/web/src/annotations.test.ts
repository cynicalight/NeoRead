import { expect, it, vi } from "vitest";
import type { Annotation, ReaderSelection } from "@neoread/core";
import {
  epubAnnotationOrder,
  activeAnnotation,
  annotationRequests,
  applySavedAnnotation,
  saveAnnotationParts,
} from "./annotations";
const a: Annotation = {
  id: "a",
  documentId: "doc",
  kind: "underline",
  location: { type: "pdf", page: 1 },
  quote: "one two",
  note: "",
  color: "",
  createdAt: "",
};
it("creates independent source and translation highlight requests", () => {
  const source = {
    text: "source",
    location: { type: "pdf" as const, page: 1, sourceAnchors: [] },
  };
  const translation = {
    text: "译文",
    location: {
      type: "pdf" as const,
      page: 1,
      translation: {
        blockId: "a",
        sourceHash: "h",
        sentenceIndexes: [0],
        start: 0,
        end: 2,
      },
    },
  };
  const selected = {
    ...source,
    text: "source 译文",
    parts: [source, translation],
  };
  const requests = annotationRequests(
    "highlight",
    selected,
    source.location,
    "",
    "#e6b94c",
  );
  expect(requests).toHaveLength(2);
  expect(requests.map((r) => r.quote)).toEqual(["source", "译文"]);
  expect(requests[0].location).not.toHaveProperty("translation");
  expect(requests[1].location).not.toHaveProperty("sourceAnchors");
  expect(
    annotationRequests("note", selected, source.location, "note", "#e6b94c"),
  ).toHaveLength(1);
});
it("replaces a merged underline in place and removes only superseded IDs", () => {
  const note = { ...a, id: "note", kind: "note" as const, note: "Keep this" };
  const result = applySavedAnnotation(
    [a, note, { ...a, id: "b", quote: "two three" }],
    { ...a, quote: "one two three", replacedIds: ["b"] },
  );
  expect(result.map((item) => item.id)).toEqual(["a", "note"]);
  expect(result[0].quote).toBe("one two three");
  expect(result[1]).toBe(note);
  expect(result[0]).not.toHaveProperty("replacedIds");
  expect(
    applySavedAnnotation(result, { ...a, quote: "one two three" }),
  ).toEqual(result);
});
it("edits an existing note when several annotation kinds cover a passage", () => {
  const note = { ...a, id: "note", kind: "note" as const, note: "Keep this" };
  expect(activeAnnotation([a, note], [a.id, note.id])).toBe(note);
  expect(activeAnnotation([a, note], [a.id])).toBe(a);
});

it.each(["epub", "pdf"] as const)(
  "saves independent %s mixed marks and retries only the unsaved side after failure",
  async (format) => {
    const location: ReaderSelection["location"] =
      format === "epub"
        ? { type: "epub", href: "a", blockId: "a", start: 0, end: 6 }
        : { type: "pdf", page: 1 };
    const parts: NonNullable<ReaderSelection["parts"]> = [
      {
        text: "source",
        location,
      },
      {
        text: "译文",
        location: {
          ...location,
          translation: {
            blockId: "a",
            sourceHash: "hash",
            sentenceIndexes: [0],
            start: 0,
            end: 2,
          },
        },
      },
    ];
    const selection: ReaderSelection = { ...parts[0], parts };
    let remaining = selection;
    const saved = vi.fn();
    const save = vi
      .fn()
      .mockResolvedValueOnce({
        ...a,
        id: "source",
        quote: "source",
        location: parts[0].location,
      })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      saveAnnotationParts(selection, save, saved, (p) => {
        remaining = p;
      }),
    ).rejects.toThrow("offline");
    expect(saved).toHaveBeenCalledTimes(1);
    expect(remaining.parts).toEqual([parts[1]]);
    save.mockResolvedValueOnce({
      ...a,
      id: "translation",
      quote: "译文",
      location: parts[1].location,
    });
    await saveAnnotationParts(remaining, save, saved, (p) => {
      remaining = p;
    });
    expect(save.mock.calls.map((c) => c[0])).toEqual([
      parts[0],
      parts[1],
      parts[1],
    ]);
    expect(saved.mock.calls.map((c) => c[0].id)).toEqual([
      "source",
      "translation",
    ]);
  },
);

it("orders EPUB annotations by chapter, paragraph index and offset, not IDs or progress", () => {
  const positions = new Map([
    ["z", { chapter: 0, block: 0 }],
    ["a", { chapter: 0, block: 2 }],
    ["b", { chapter: 1, block: 0 }],
  ]);
  const mark = (
    id: string,
    blockId: string,
    start: number,
    href = "z.xhtml",
  ): Annotation => ({
    ...a,
    id,
    createdAt: "2026-01-01",
    location: {
      type: "epub",
      href,
      blockId,
      start,
      order: positions.get(blockId),
    },
  });
  const first = mark("first", "z", 2);
  first.location = {
    ...first.location,
    progression: 0.9,
  } as typeof first.location;
  const later = mark("later", "a", 0);
  const target = {
    ...later,
    id: "target",
    location: {
      ...later.location,
      translation: {
        blockId: "a",
        sourceHash: "hash",
        sentenceIndexes: [0],
        start: 1,
        end: 3,
      },
    },
  };
  const lost = mark("lost", "missing", 0);
  lost.createdAt = "2000-01-01";
  const items = [
    mark("next", "b", 0, "a.xhtml"),
    target,
    later,
    mark("same-paragraph", "z", 8),
    first,
    lost,
  ];
  expect(items.sort(epubAnnotationOrder).map((a) => a.id)).toEqual([
    "first",
    "same-paragraph",
    "later",
    "target",
    "next",
    "lost",
  ]);
});

it("keeps legacy and unresolved EPUB annotations after ordered marks with stable time ties", () => {
  const mark = (
    id: string,
    order?: { chapter: number; block: number },
    unresolved?: boolean,
  ): Annotation => ({
    ...a,
    id,
    createdAt: "2026-01-01",
    location: { type: "epub", href: "chapter.xhtml", order, unresolved },
  });
  const items = [
    mark("z-old"),
    mark("unresolved", { chapter: 0, block: 0 }, true),
    mark("a-old"),
    mark("new", { chapter: 9, block: 3 }),
  ];
  expect(items.sort(epubAnnotationOrder).map((item) => item.id)).toEqual([
    "new",
    "a-old",
    "unresolved",
    "z-old",
  ]);
});
