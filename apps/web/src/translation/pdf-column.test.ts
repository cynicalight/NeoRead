import { describe, expect, it } from "vitest";
import { pdfFocusWidth, pdfTranslationColumn } from "./pdf-column";

const block = (label: string, width: number, text = "text") => ({
  label,
  text,
  bounds: { x: 0.1, y: 0, width, height: 0.02 },
});

describe("pdfFocusWidth", () => {
  it("uses the median body block at the focus zoom limit", () => {
    // 612pt letter page = 816 CSS px; a 0.38 column at 150%.
    expect(
      pdfFocusWidth(
        [
          block("text", 0.38),
          block("text", 0.38),
          block("text", 0.8),
          block("paragraph_title", 0.1),
        ],
        816,
      ),
    ).toBe(Math.round(0.38 * 816 * 1.5));
  });

  it("falls back to any text block and needs a page width", () => {
    expect(pdfFocusWidth([block("doc_title", 0.5)], 800)).toBe(600);
    expect(pdfFocusWidth([block("text", 0.5, " ")], 800)).toBeUndefined();
    expect(pdfFocusWidth([block("text", 0.5)], undefined)).toBeUndefined();
  });
});

describe("pdfTranslationColumn", () => {
  it("keeps the focused width at the default margin of 48", () => {
    expect(pdfTranslationColumn(600)).toBe(600);
    expect(pdfTranslationColumn(600, 48)).toBe(600);
  });

  it("narrows with more margin and widens with less, from 0 to 96", () => {
    expect(pdfTranslationColumn(600, 64)).toBe(568);
    expect(pdfTranslationColumn(600, 0)).toBe(696);
    expect(pdfTranslationColumn(600, 96)).toBe(504);
    // Values saved outside the scale are clamped.
    expect(pdfTranslationColumn(600, -32)).toBe(696);
    expect(pdfTranslationColumn(300, 96)).toBe(240);
  });
});
