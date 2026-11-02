// @vitest-environment jsdom
import { useReaderStore } from "../store";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EPUBReadingBlock } from "@neoread/core";
import {
  EPUBBlockOverlay,
  epubBlockId,
  epubBlockRect,
} from "./epub-block-focus";

let container: HTMLDivElement;
let overlay: EPUBBlockOverlay;
const onHover = vi.fn(),
  onFocus = vi.fn(),
  onAction = vi.fn();
const block = (id: string, image?: string): EPUBReadingBlock => ({
  id,
  label: image ? "image" : "text",
  text: id,
  image,
  location: { type: "epub", href: "a.xhtml" },
});
const rect = (element: Element, top: number, left = 40, height = 40) =>
  ((element as HTMLElement).getBoundingClientRect = () =>
    new DOMRect(left, top, 200, height));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.getState().setTheme({ reducedMotion: true });
  container = document.createElement("div");
  container.innerHTML = `<section>
    <p data-epub-block="p">Plain <em>paragraph</em>.</p>
    <div><span data-epub-run="m" data-epub-block="m">Mixed one</span><br>
    <span data-epub-run="m">mixed two</span></div>
    <p data-epub-block="tall">Tall</p>
    <img data-epub-block="pic" alt="Chart">
  </section>`;
  document.body.append(container);
  Object.defineProperty(container, "clientHeight", { value: 400 });
  Object.defineProperty(container, "scrollHeight", { value: 5000 });
  container.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
  rect(container.querySelector('[data-epub-block="p"]')!, 600);
  const [first, second] = container.querySelectorAll("[data-epub-run]");
  rect(first, 100, 60, 20);
  rect(second, 130, 40, 20);
  rect(container.querySelector('[data-epub-block="tall"]')!, 800, 40, 900);
  rect(container.querySelector('[data-epub-block="pic"]')!, 1800);
  overlay = new EPUBBlockOverlay(
    container,
    onHover,
    onFocus,
    () => [block("p"), block("m"), block("tall"), block("pic", "img/a.png")],
    onAction,
  );
});
afterEach(() => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  act(() => overlay.destroy());
  container.remove();
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("identifies paragraphs and the shared runs of mixed containers", () => {
  expect(epubBlockId(container.querySelector("em"))).toBe("p");
  expect(epubBlockId(container.querySelectorAll("[data-epub-run]")[1])).toBe(
    "m",
  );
  expect(epubBlockId(container.querySelector("section"))).toBeUndefined();
  // Union of both runs, padded like a parsed block.
  expect(epubBlockRect(container, "m")).toEqual({
    top: 96,
    left: 32,
    width: 236,
    height: 58,
  });
});

it("shows the hover box and reports the hovered block", () => {
  const run = container.querySelectorAll("[data-epub-run]")[1];
  run.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  const box = container.querySelector<HTMLElement>(".neoread-block-hover")!;
  expect(box.dataset.blockId).toBe("m");
  expect(box.style.top).toBe("96px");
  expect(onHover).toHaveBeenLastCalledWith("m");
  container.dispatchEvent(new MouseEvent("pointerleave"));
  expect(container.querySelector(".neoread-block-hover")).toBeNull();
  expect(onHover).toHaveBeenLastCalledWith(null);
});

it("focuses a clicked block but not after a drag or text selection", () => {
  const paragraph = container.querySelector('[data-epub-block="p"]')!;
  const event = (x: number) => {
    paragraph.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }),
    );
    const e = new MouseEvent("click", { clientX: x, bubbles: true });
    paragraph.addEventListener("click", (c) => overlay.click(c as MouseEvent), {
      once: true,
    });
    paragraph.dispatchEvent(e);
  };
  event(2);
  expect(onFocus).toHaveBeenCalledWith("p");
  onFocus.mockClear();
  event(20);
  expect(onFocus).not.toHaveBeenCalled();
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  window.getSelection()!.addRange(range);
  event(0);
  expect(onFocus).not.toHaveBeenCalled();
});

it("centers a block, top-aligns a tall one, and removes the box", async () => {
  await overlay.focus("p");
  // The padded box (596, 48 high) sits at (400 - 48) / 2.
  expect(container.scrollTop).toBe(420);
  expect(container.querySelector(".neoread-block-focus")).toBeNull();
  container.scrollTop = 0;
  await overlay.focus("tall");
  expect(container.scrollTop).toBe(796 - 16);
  expect(await overlay.focus("missing")).toBe(false);
});

it("offers copy and ask-AI on paragraphs and preview on images", () => {
  const hover = (selector: string) =>
    act(() =>
      container
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
    );
  const actions = () =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        ".neoread-block-hover [data-block-action]",
      ),
      (button) => button.dataset.blockAction,
    );
  hover('[data-epub-block="p"]');
  expect(actions()).toEqual(["copy", "explain"]);
  hover('[data-epub-block="pic"]');
  expect(actions()).toEqual(["preview", "copy", "explain"]);
  const button = container.querySelector<HTMLElement>(
    '[data-block-action="preview"]',
  )!;
  // Reaching the buttons keeps the box and never focuses the block.
  button.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  button.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  act(() => button.click());
  expect(onAction).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pic" }),
    "preview",
  );
  expect(container.querySelector(".neoread-block-hover")).toBeTruthy();
  overlay.click(new MouseEvent("click"));
  expect(onFocus).not.toHaveBeenCalled();
});

it("keeps the toolbar reachable across the box margin above the block", () => {
  const section = container.querySelector("section")!;
  const at = (target: Element, clientX: number, clientY: number) =>
    act(() =>
      target.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX, clientY }),
      ),
    );
  // The paragraph's text starts at y=600; its box starts 4px higher.
  at(container.querySelector('[data-epub-block="p"]')!, 100, 610);
  at(section, 230, 597);
  const box = () =>
    container.querySelector<HTMLElement>(".neoread-block-hover");
  expect(box()?.dataset.blockId).toBe("p");
  at(container.querySelector('[data-block-action="copy"]')!, 230, 590);
  expect(box()?.dataset.blockId).toBe("p");
  expect(onHover).not.toHaveBeenLastCalledWith(null);
  // Outside the box the hover ends.
  at(section, 230, 580);
  expect(box()).toBeNull();
  expect(onHover).toHaveBeenLastCalledWith(null);
});
