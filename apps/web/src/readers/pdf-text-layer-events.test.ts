// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { TextLayerBuilder as Builder } from "pdfjs-dist/web/pdf_viewer.mjs";

let TextLayerBuilder: typeof Builder;
const layers: Builder[] = [];
beforeAll(async () => {
  vi.stubGlobal("DOMMatrix", class {});
  const pdfjs = await import("pdfjs-dist");
  vi.stubGlobal("pdfjsLib", {
    ...pdfjs,
    // Exercise PDF.js's real global selection listeners without font/canvas work.
    TextLayer: class {
      textDivs: HTMLElement[] = [];
      textContentItemsStr: string[] = [];
      constructor({ container }: { container: HTMLElement }) {
        const span = document.createElement("span");
        span.textContent = "A paragraph for selection.";
        container.append(span);
        this.textDivs.push(span);
        this.textContentItemsStr.push(span.textContent);
      }
      async render() {}
      cancel() {}
    },
  });
  ({ TextLayerBuilder } = await import("pdfjs-dist/web/pdf_viewer.mjs"));
});
afterEach(() => {
  window.getSelection()!.removeAllRanges();
  for (const layer of layers.splice(0)) layer.cancel();
  document.body.replaceChildren();
});
afterAll(() => vi.unstubAllGlobals());
async function layer() {
  const instance = new TextLayerBuilder({
    pdfPage: { streamTextContent: () => ({}) } as unknown as PDFPageProxy,
  });
  layers.push(instance);
  document.body.append(instance.div);
  await instance.render({} as Parameters<Builder["render"]>[0]);
  return instance.div;
}

it("does not mutate clean PDF text layers while editing another control", async () => {
  const first = await layer(),
    second = await layer();
  const input = document.createElement("textarea");
  document.body.append(input);
  input.value = "长中文草稿".repeat(1000);
  input.focus();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const changed = vi.fn();
  const observer = new MutationObserver(changed);
  for (const element of [first, second])
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  try {
    for (let i = 0; i < 5; i++) {
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }),
      );
      document.dispatchEvent(new Event("selectionchange"));
    }
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(first.querySelector(".endOfContent")).toBe(first.lastChild);
  } finally {
    observer.disconnect();
  }
});

it("still restores a moved selection sentinel and preserves the selected text", async () => {
  const element = await layer();
  const span = element.querySelector("span")!;
  const end = element.querySelector<HTMLElement>(".endOfContent")!;
  span.append(end);
  end.style.width = "100px";
  end.style.height = "80px";
  element.classList.add("selecting");
  const range = document.createRange();
  range.selectNodeContents(span.firstChild!);
  window.getSelection()!.addRange(range);
  const text = window.getSelection()!.toString();
  document.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Shift", bubbles: true }),
  );
  expect(element.lastChild).toBe(end);
  expect(end.style.width).toBe("");
  expect(end.style.height).toBe("");
  expect(element.classList.contains("selecting")).toBe(false);
  expect(window.getSelection()!.toString()).toBe(text);
});
