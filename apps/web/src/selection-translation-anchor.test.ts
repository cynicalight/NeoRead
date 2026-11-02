// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { captureSelectionTranslationAnchor } from "./selection-translation-anchor";
const original = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect",
);
afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  if (original)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
  else
    delete (Range.prototype as unknown as Record<string, unknown>)
      .getBoundingClientRect;
});
it("tracks the selected words after native selection is cleared and pins them to each reading boundary", () => {
  const pane = document.createElement("div");
  pane.innerHTML =
    '<div class="pdf-container"><span>selected words</span></div>';
  document.body.append(pane);
  const scroller = pane.firstElementChild as HTMLElement;
  pane.getBoundingClientRect = () => new DOMRect(20, 60, 900, 500);
  scroller.getBoundingClientRect = () => new DOMRect(40, 80, 400, 440);
  let left = 100,
    top = 250;
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(left, top - scroller.scrollTop, 60, 20),
  });
  const range = document.createRange();
  range.selectNodeContents(scroller.firstElementChild!);
  window.getSelection()!.addRange(range);
  const anchor = captureSelectionTranslationAnchor(
    { x: 130, top: 250, bottom: 270 },
    pane,
  );
  window.getSelection()!.removeAllRanges();
  expect(anchor.getBoundingClientRect().top).toBe(250);
  scroller.scrollTop = 80;
  expect(anchor.getBoundingClientRect().top).toBe(170);
  scroller.scrollTop = 500;
  expect(anchor.getBoundingClientRect().top).toBe(88);
  top = 1200;
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(513);
  left = 1000;
  expect(anchor.getBoundingClientRect().left).toBe(432);
  left = -200;
  expect(anchor.getBoundingClientRect().left).toBe(48);
  expect(anchor.boundary).toBe(pane);
});
it("keeps following scroll coordinates when PDF.js recycles the selected text layer", () => {
  const pane = document.createElement("div");
  pane.innerHTML = '<div class="translation-document"><span>words</span></div>';
  document.body.append(pane);
  const scroller = pane.firstElementChild as HTMLElement;
  pane.getBoundingClientRect = scroller.getBoundingClientRect = () =>
    new DOMRect(0, 0, 500, 500);
  const range = document.createRange();
  range.selectNodeContents(scroller.firstElementChild!);
  window.getSelection()!.addRange(range);
  const anchor = captureSelectionTranslationAnchor(
    { x: 200, top: 250, bottom: 270 },
    pane,
  );
  scroller.innerHTML = "";
  scroller.scrollTop = 100;
  expect(anchor.getBoundingClientRect().top).toBe(150);
});
