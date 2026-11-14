import { expect, it, vi } from "vitest";
import type { EPUBLocation, PDFLocation, ReaderSelection } from "@neoread/core";
import { readingContext } from "./reading-context";

it("never extracts page text for ordinary questions or image attachments", async () => {
  for (const hasImages of [false, true]) {
    const position: PDFLocation = {
      type: "pdf",
      page: 5,
      y: 0.6,
      quote: "not an explicit quote",
    };
    const reader = {
      getLocation: () => position,
      getContext: vi.fn(async () => "page text"),
    };
    const pending = readingContext(reader, [], false, hasImages);
    position.page = 9;
    const result = await pending;
    expect(result).toEqual({
      context: "",
      references: [],
      readingLocation: { type: "pdf", page: 5, x: undefined, y: 0.6 },
    });
    expect(result.readingLocation).not.toHaveProperty("quote");
    expect(reader.getContext).not.toHaveBeenCalled();
  }
});

it("sends a native EPUB position for explicit chapter questions", async () => {
  const position: EPUBLocation = {
    type: "epub",
    href: "ch2.xhtml#section",
    progression: 0.7,

    blockId: "b7",
  };
  const reader = {
    getLocation: () => position,
    getContext: vi.fn(async () => "whole chapter"),
  };
  const result = await readingContext(reader, [], true, false);
  position.href = "ch3.xhtml";
  expect(result.readingLocation).toMatchObject({
    href: "ch2.xhtml#section",
    progression: 0.7,

    blockId: "b7",
  });
  expect(result.context).toBe("");
  expect(result.references).toEqual([]);
  expect(reader.getContext).not.toHaveBeenCalled();
});

it("sends only the selected passage without requiring parsed chapter text", async () => {
  const selected: ReaderSelection[] = [
    { text: "exact selected sentence", location: { type: "pdf", page: 2 } },
  ];
  const reader = {
    getLocation: () => ({ type: "pdf" as const, page: 8 }),
    getContext: vi.fn(async () => {
      throw new Error("unparsed chapter");
    }),
  };
  const pending = readingContext(reader, selected, false, false);
  selected[0].text = "changed selection";
  selected[0].location = { type: "pdf", page: 3 };
  const result = await pending;
  expect(result.context).toBe("[选区 · 第 2 页]\nexact selected sentence");
  expect(result.references).toEqual([
    {
      text: "exact selected sentence",
      location: { type: "pdf", page: 2 },
      kind: "selection",
    },
  ]);
  expect(reader.getContext).not.toHaveBeenCalled();
});

it("reads text when a page summary explicitly includes images", async () => {
  const position: PDFLocation = { type: "pdf", page: 4 };
  const reader = {
    getLocation: () => position,
    getContext: vi.fn(async () => {
      position.page = 7;
      return "page four text";
    }),
  };
  const result = await readingContext(reader, [], true, true);
  expect(result.context).toBe("page four text");
  expect(result.readingLocation).toMatchObject({ page: 4 });
  expect(result.references[0]).toMatchObject({
    kind: "section",
    location: { page: 4 },
  });
});

it("keeps long explicit quotations intact and rejects oversized UTF-8 input", async () => {
  const quote: ReaderSelection = {
    text: "文".repeat(60000) + "末尾",
    location: { type: "pdf", page: 2 },
  };
  const result = await readingContext(undefined, [quote], false, false);
  expect(result.context.endsWith(quote.text)).toBe(true);
  expect(result.references[0].text).toBe(quote.text);
  await expect(
    readingContext(
      undefined,
      [{ ...quote, text: "文".repeat(90000) }],
      false,
      false,
    ),
  ).rejects.toThrow("256 KB");
});
