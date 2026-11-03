import { expect, it, vi } from "vitest";
import type { DocumentLocation } from "@neoread/core";
import { referenceCards, contextReferences } from "./references";
import { ReferenceNavigation } from "./reference-navigation";
import { pdfQuotePoint } from "./readers/pdf-reference-location";

it("keeps quoted conversation text separate from original-document navigation", () => {
  const cards = referenceCards(
    { references: [{ kind: "chat", text: "quoted conversation" }] },
    [],
  );
  expect(cards).toEqual([
    expect.objectContaining({
      kind: "chat",
      label: "引用对话",
      text: "quoted conversation",
    }),
  ]);
  expect(cards[0].location).toBeUndefined();
  expect(cards[0].sourceId).toBeUndefined();
});

it("uses exact saved locations for selected passages and bounds long previews", () => {
  const location: DocumentLocation = {
    type: "epub",
    href: "ch2.xhtml",
    locator: '{"locations":{"domRange":{}}}',
  };
  const cards = referenceCards(
    { references: [{ text: "A long passage ".repeat(100), location }] },
    [{ id: "2", label: "第二章", location, children: [] }],
  );
  expect(cards).toHaveLength(1);
  expect(cards[0].label).toBe("第二章 · 重点句");
  expect(cards[0].location).toEqual(location);
  expect(cards[0].preview.length).toBeLessThanOrEqual(161);
});
it("splits legacy context into compact entries without inventing historical locations", () => {
  const cards = referenceCards(
    { context: "First statement. ".repeat(50) + "\n\nA second paragraph." },
    [],
  );
  expect(cards.length).toBeGreaterThan(2);
  expect(
    cards.every((card) => card.preview.length <= 161 && !card.location),
  ).toBe(true);
  expect(cards.at(-1)?.text).toBe("A second paragraph.");
});
it("keeps the page or chapter used for automatic context, independent of subsequent reading", () => {
  const position: DocumentLocation = { type: "pdf", page: 6, y: 0.7 };
  const references = contextReferences("Page text", position);
  position.page = 9;
  expect(references[0].location).toEqual({ type: "pdf", page: 6 });
  expect(references[0].kind).toBe("section");
  expect(
    contextReferences("Chapter text", {
      type: "epub",
      href: "ch2.xhtml#end",
      progression: 0.8,
    })[0].location,
  ).toEqual({ type: "epub", href: "ch2.xhtml", progression: 0 });
});
it("returns to the original position after visiting multiple citations", async () => {
  let current: DocumentLocation = { type: "pdf", page: 8, x: 0.1, y: 0.65 };
  const reader = {
    getLocation: () => current,
    goTo: vi.fn(async (target: DocumentLocation) => {
      current = target;
    }),
  };
  const navigation = new ReferenceNavigation(reader);
  await navigation.visit({ type: "pdf", page: 1 });
  await navigation.visit({ type: "pdf", page: 3 });
  await navigation.back();
  expect(current).toEqual({ type: "pdf", page: 8, x: 0.1, y: 0.65 });
  expect(navigation.origin).toBeUndefined();
});
it("uses block-focused navigation for a source reference and keeps its return point", async () => {
  const original: DocumentLocation = { type: "pdf", page: 8, y: 0.6 };
  const target: DocumentLocation = { type: "pdf", page: 2 };
  const reader = {
    getLocation: () => original,
    goTo: vi.fn(async () => {}),
  };
  const focus = vi.fn(async () => {});
  const navigation = new ReferenceNavigation(reader);
  await navigation.visit(target, focus);
  expect(focus).toHaveBeenCalledWith(target);
  expect(reader.goTo).not.toHaveBeenCalled();
  expect(navigation.origin).toEqual(original);
});
it("retains a return point on failed navigation and permits retrying", async () => {
  const reader = {
    getLocation: () => ({
      type: "epub" as const,
      href: "ch2.xhtml",
      locator: "exact-position",
    }),
    goTo: vi.fn().mockResolvedValue(undefined),
  };
  const navigation = new ReferenceNavigation(reader);
  await navigation.visit({ type: "epub", href: "ch1.xhtml" });
  reader.goTo.mockRejectedValueOnce(new Error("navigation failed"));
  await expect(navigation.back()).rejects.toThrow("navigation failed");
  expect(navigation.origin?.type).toBe("epub");
  expect(navigation.busy).toBe(false);
  await navigation.back();
  expect(reader.goTo).toHaveBeenLastCalledWith({
    type: "epub",
    href: "ch2.xhtml",
    locator: "exact-position",
  });
});
it("finds a PDF quote's text run instead of always jumping to the page top", () => {
  const point = pdfQuotePoint(
    [
      { str: "Heading", transform: [1, 0, 0, 1, 50, 750], height: 12 },
      {
        str: "The cited sentence.",
        transform: [1, 0, 0, 1, 80, 300],
        height: 10,
      },
    ],
    "cited sentence",
    { width: 600, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y] },
  );
  expect(point).toEqual({ x: 80 / 600, y: 490 / 800 });
});
