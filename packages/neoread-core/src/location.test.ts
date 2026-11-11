import { describe, expect, it } from "vitest";
import { locationLabel, type DocumentLocation } from "./index";
describe("format-specific persistent locations", () => {
  it("retains EPUB locators without inventing page numbers", () => {
    const saved: DocumentLocation = {
      type: "epub",
      href: "chapter.xhtml",
      blockId: "p1",
      start: 2,
      end: 8,
      quote: "quoted passage",
      progression: 0.32,
    };
    const restored: DocumentLocation = JSON.parse(JSON.stringify(saved));
    expect(restored).toEqual(saved);
    expect(locationLabel(restored)).toBe("章节进度 32%");
    expect(restored).not.toHaveProperty("page");
  });
  it("labels a PDF page and preserves selection rectangles", () => {
    const saved: DocumentLocation = {
      type: "pdf",
      page: 12,
      rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }],
    };
    expect(locationLabel(saved)).toBe("第 12 页");
    expect(JSON.parse(JSON.stringify(saved)).rects[0].width).toBe(0.4);
  });
});
