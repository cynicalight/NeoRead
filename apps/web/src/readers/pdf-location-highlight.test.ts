// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PDFLocationHighlight } from "./pdf-location-highlight";
let host: HTMLDivElement, page: HTMLDivElement, marks: PDFLocationHighlight;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 1000);
  host.append(page);
  document.body.append(host);
  marks = new PDFLocationHighlight(host);
});
afterEach(() => {
  marks.clear();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("shows saved annotation geometry without parsed blocks or text layers", () => {
  marks.show({
    type: "pdf",
    page: 1,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
  });
  const mark = page.querySelector<HTMLElement>(
    ".reader-location-highlight > div",
  )!;
  expect(mark.style.left).toBe("10%");
  expect(mark.style.width).toBe("30%");
  vi.advanceTimersByTime(3000);
  expect(page.querySelector(".reader-location-highlight")).toBeNull();
});
it("waits for the text layer and highlights only the search match after it renders", () => {
  marks.show({ type: "pdf", page: 1, quote: "target" });
  vi.advanceTimersByTime(4000);
  page.innerHTML =
    '<div class="textLayer"><span>before target after</span></div>';
  const getRects = vi.fn(function (this: Range) {
    expect(this.toString()).toBe("target");
    return [new DOMRect(70, 100, 60, 10)] as unknown as DOMRectList;
  });
  const rangeRects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = getRects;
  marks.paint();
  expect(getRects).toHaveBeenCalled();
  expect(
    page.querySelector<HTMLElement>(".reader-location-highlight > div")!.style
      .width,
  ).toBe("6%");
  marks.paint();
  expect(page.querySelectorAll(".reader-location-highlight")).toHaveLength(1);
  Range.prototype.getClientRects = rangeRects;
});
it("replaces old targets and clears pending feedback", () => {
  marks.show({
    type: "pdf",
    page: 1,
    rects: [{ x: 0, y: 0, width: 1, height: 1 }],
  });
  marks.show({ type: "pdf", page: 2, quote: "missing" });
  expect(page.querySelector(".reader-location-highlight")).toBeNull();
  marks.clear();
  marks.paint();
  expect(page.querySelector(".reader-location-highlight")).toBeNull();
});
