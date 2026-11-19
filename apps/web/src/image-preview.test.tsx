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

it("zooms and resets the image using the header controls", async () => {
  const dialog = document.querySelector('[role="dialog"]')!;
  const header = dialog.querySelector('[data-slot="dialog-header"]')!;
  const image = dialog.querySelector("img")!;
  const click = (button: HTMLButtonElement) => act(async () => button.click());
  await click(
    header.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!,
  );
  expect(image.style.width).toBe("125%");
  const fit = [...header.querySelectorAll("button")].find(
    (b) => b.textContent === "适应窗口",
  )!;
  await click(fit);
  expect(image.style.width).toBe("100%");
  await click(
    header.querySelector<HTMLButtonElement>('[aria-label="缩小图片"]')!,
  );
  expect(image.style.width).toBe("75%");
});
