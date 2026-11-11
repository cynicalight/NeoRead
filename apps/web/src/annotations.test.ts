import { expect, it } from "vitest";
import type { Annotation } from "@neoread/core";
import {
  activeAnnotation,
  annotationRequests,
  applySavedAnnotation,
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
