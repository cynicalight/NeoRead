// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImagePreview } from "./ImagePreview";

vi.mock("@neoread/api", () => ({
  blockImageURL: () => "/image.png",
}));

let root: Root, host: HTMLDivElement;
let close = vi.fn<() => void>();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  close = vi.fn();
  await act(async () =>
    root.render(
      <ImagePreview
        documentId="doc"
        image={{ id: "image", page: 3, label: "figure" }}
        onClose={close}
      />,
    ),
  );
});

it("provides a separate close control above the preview image", async () => {
  const button = document.querySelector<HTMLButtonElement>(
    '[aria-label="关闭图片预览"]',
  )!;
  expect(button).not.toBeNull();
  expect(button.closest(".image-preview-scroll")).toBeNull();
  await act(async () => button.click());
  expect(close).toHaveBeenCalledOnce();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("places centered zoom controls below the image without pixel dimensions", async () => {
  const dialog = document.querySelector('[role="dialog"]')!;
  const scroll = dialog.querySelector(".image-preview-scroll")!;
  const controls = dialog.querySelector(".image-preview-controls")!;
  expect(
    scroll.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const image = scroll.querySelector("img")!;
  Object.defineProperties(image, {
    naturalWidth: { value: 640 },
    naturalHeight: { value: 480 },
  });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(dialog.textContent).not.toContain("640 × 480");
});

it("keeps the frame at the source image aspect ratio and fixes zoom around the pointer", async () => {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const scroll = dialog.querySelector<HTMLElement>(".image-preview-scroll")!;
  const image = scroll.querySelector("img")!;
  Object.defineProperties(image, {
    naturalWidth: { value: 640, configurable: true },
    naturalHeight: { value: 480, configurable: true },
  });
  await act(async () => image.dispatchEvent(new Event("load")));
  const width = parseFloat(dialog.style.width),
    height = parseFloat(dialog.style.height);
  expect(width / height).toBeCloseTo(640 / 480);
  expect(image.style.width).toBe(`${width}px`);
  expect(image.style.height).toBe(`${height}px`);
  Object.defineProperties(scroll, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  scroll.getBoundingClientRect = () => new DOMRect(100, 80, width, height);
  await act(async () =>
    scroll.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -300 * Math.log(2),
        clientX: 250,
        clientY: 160,
      }),
    ),
  );
  expect(scroll.scrollLeft).toBeCloseTo(150);
  expect(scroll.scrollTop).toBeCloseTo(80);
  expect(dialog.style.width).toBe(`${width}px`);
  expect(dialog.style.height).toBe(`${height}px`);
  Object.defineProperties(image, {
    naturalWidth: { value: 4000, configurable: true },
    naturalHeight: { value: 2998, configurable: true },
  });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(dialog.style.width).toBe(`${width}px`);
  expect(dialog.style.height).toBe(`${height}px`);
  const fit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "完整图片",
  )!;
  await act(async () => fit.click());
  expect(scroll.scrollLeft).toBe(0);
  expect(scroll.scrollTop).toBe(0);
  expect(
    dialog.querySelector<HTMLButtonElement>('[aria-label="缩小图片"]')!
      .disabled,
  ).toBe(true);
});
