import { expect, it, vi } from "vitest";
import type { EPUBLocation, PDFLocation, ReaderSelection } from "@neoread/core";
import { readingContext } from "./reading-context";

it("keeps conversation quotes distinct from mixed original and translated selections", async () => {
  const result = await readingContext(
    undefined,
    "api",
    [
      { kind: "chat", text: "quoted answer" },
      { text: "original selection", location: { type: "pdf", page: 4 } },
      {
        text: "translated selection",
        location: { type: "epub", href: "chapter.xhtml" },
      },
    ],
    false,
    false,
  );
  expect(result.references).toEqual([
    { kind: "chat", text: "quoted answer" },
    {
      kind: "selection",
      text: "original selection",
      location: { type: "pdf", page: 4 },
    },
    {
      kind: "selection",
      text: "translated selection",
      location: { type: "epub", href: "chapter.xhtml" },
    },
  ]);
  expect(result.context).toContain(
    "[引用对话 · 不作为原文证据]\nquoted answer",
  );
  expect(result.context).toContain("[选区 · 第 4 页]\noriginal selection");
});

it.each(["codex", "api", "claude", "kimi"])(
  "%s never extracts page text for ordinary questions or image attachments",
  async (provider) => {
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
      const pending = readingContext(reader, provider, [], false, hasImages);
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
  },
);

it.each(["codex", "api"])(
  "%s sends a native EPUB position for explicit chapter questions",
  async (provider) => {
    const position: EPUBLocation = {
      type: "epub",
      href: "ch2.xhtml#section",
      progression: 0.7,
      locator: '{"href":"ch2.xhtml","type":"application/xhtml+xml"}',
      blockId: "b7",
    };
    const reader = {
      getLocation: () => position,
      getContext: vi.fn(async () => "whole chapter"),
    };
    const result = await readingContext(reader, provider, [], true, false);
    position.href = "ch3.xhtml";
    expect(result.readingLocation).toMatchObject({
      href: "ch2.xhtml#section",
      progression: 0.7,
      locator: position.locator,
      blockId: "b7",
    });
    expect(result.context).toBe("");
    expect(result.references).toEqual([]);
    expect(reader.getContext).not.toHaveBeenCalled();
  },
);

it.each(["codex", "api", "claude", "kimi"])(
  "%s sends only the selected passage without requiring parsed chapter text",
  async (provider) => {
    const selected: ReaderSelection[] = [
      { text: "exact selected sentence", location: { type: "pdf", page: 2 } },
    ];
    const reader = {
      getLocation: () => ({ type: "pdf" as const, page: 8 }),
      getContext: vi.fn(async () => {
        throw new Error("unparsed chapter");
      }),
    };
    const pending = readingContext(reader, provider, selected, false, false);
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
  },
);

it.each(["claude", "kimi"])(
  "%s still reads text for an explicitly requested page summary",
  async (provider) => {
    const position: PDFLocation = { type: "pdf", page: 4 };
    const reader = {
      getLocation: () => position,
      getContext: vi.fn(async () => {
        position.page = 7;
        return "page four text";
      }),
    };
    const result = await readingContext(reader, provider, [], true, false);
    expect(result.context).toBe("page four text");
    expect(result.readingLocation).toMatchObject({ page: 4 });
    expect(result.references[0]).toMatchObject({
      kind: "section",
      location: { page: 4 },
    });
  },
);

it("keeps long explicit quotations intact and rejects oversized UTF-8 input", async () => {
  const quote: ReaderSelection = {
    text: "文".repeat(60000) + "末尾",
    location: { type: "pdf", page: 2 },
  };
  const result = await readingContext(undefined, "api", [quote], false, false);
  expect(result.context.endsWith(quote.text)).toBe(true);
  expect(result.references[0].text).toBe(quote.text);
  await expect(
    readingContext(
      undefined,
      "api",
      [{ ...quote, text: "文".repeat(90000) }],
      false,
      false,
    ),
  ).rejects.toThrow("256 KB");
});
