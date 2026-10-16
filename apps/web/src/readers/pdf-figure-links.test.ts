// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { PDFBlock } from "@reader/core";
import { PDFFigureLinks } from "./pdf-figure-links";
const image: PDFBlock = {
  id: "figure-3",
  page: 2,
  label: "image",
  text: "",
  caption: "Figure 3. Result",
  bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
};
afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});
it("links references split across PDF spans without changing text or transforms", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="textLayer"><span style="transform: scaleX(0.8)">See Figure</span><span>[3] and Figure 3.</span><span>Figure 9</span></div>';
  document.body.append(host);
  const before = host.textContent;
  const focus = vi.fn();
  let blocks: PDFBlock[] = [];
  const links = new PDFFigureLinks(host, () => blocks, focus);
  links.repaint();
  expect(host.querySelector("a")).toBeNull();
  blocks = [image];
  links.repaint();
  links.repaint();
  expect(host.textContent).toBe(before);
  expect(host.querySelector("span")!.style.transform).toBe("scaleX(0.8)");
  expect(host.querySelectorAll("a")).toHaveLength(3);
  host.querySelector("a")!.click();
  expect(focus).toHaveBeenCalledExactlyOnceWith(image);
  const range = document.createRange();
  range.selectNodeContents(host.querySelector("span")!);
  window.getSelection()!.addRange(range);
  host.querySelector("a")!.click();
  expect(focus).toHaveBeenCalledTimes(1);
  window.getSelection()!.removeAllRanges();
  links.destroy();
  host
    .querySelector("a")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(focus).toHaveBeenCalledTimes(1);
});
it("routes native annotations covering figure text through figure focus", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page"><div class="textLayer"><span>Figure 3</span></div><div class="annotationLayer"><a class="internalLink" href="#native"> </a></div></div>';
  document.body.append(host);
  const focus = vi.fn();
  const links = new PDFFigureLinks(host, () => [image], focus);
  links.repaint();
  const anchor = host.querySelector<HTMLAnchorElement>(
    "[data-figure-reference]",
  )!;
  anchor.getClientRects = () =>
    [new DOMRect(10, 20, 40, 15)] as unknown as DOMRectList;
  const native = host.querySelector(".annotationLayer a")!;
  native.getClientRects = () =>
    [new DOMRect(5, 15, 50, 25)] as unknown as DOMRectList;
  const sameHostListener = vi.fn();
  host.addEventListener("click", sameHostListener, true);
  const navigate = vi.fn();
  native.addEventListener("click", navigate);
  native.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 25,
    }),
  );
  expect(focus).toHaveBeenCalledWith(image);
  // Padding click outside the glyph box and keyboard-generated click (0, 0).
  native.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 6,
      clientY: 16,
    }),
  );
  (native as HTMLAnchorElement).click();
  expect(focus).toHaveBeenCalledTimes(3);
  expect(navigate).not.toHaveBeenCalled();
  expect(sameHostListener).not.toHaveBeenCalled();
  links.destroy();
});

it("preserves unrelated internal links and external links", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page"><div class="textLayer"><span>Figure 3</span></div><div class="annotationLayer"><a class="internalLink" href="#citation">[3]</a><a href="https://example.com">Figure 3</a></div></div>';
  document.body.append(host);
  const focus = vi.fn();
  const links = new PDFFigureLinks(host, () => [image], focus);
  links.repaint();
  host.querySelector<HTMLElement>("[data-figure-reference]")!.getClientRects =
    () => [new DOMRect(10, 20, 40, 15)] as unknown as DOMRectList;
  const anchors =
    host.querySelectorAll<HTMLAnchorElement>(".annotationLayer a");
  anchors[0].getClientRects = () =>
    [new DOMRect(100, 20, 40, 15)] as unknown as DOMRectList;
  anchors[1].getClientRects = () =>
    [new DOMRect(10, 20, 40, 15)] as unknown as DOMRectList;
  const native = vi.fn((event: Event) => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  });
  for (const anchor of anchors) {
    anchor.addEventListener("click", native);
    anchor.click();
  }
  expect(native).toHaveBeenCalledTimes(2);
  expect(focus).not.toHaveBeenCalled();
  links.destroy();
});
