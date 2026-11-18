// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImagePreview } from "./ImagePreview";

let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ImagePreview
        title="第 3 页 · 图表"
        alt="第 3 页 · 图表"
        src="/image.png"
        onClose={() => {}}
      />,
    ),
  );
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
