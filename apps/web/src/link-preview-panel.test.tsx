// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkPreview } from "@neoread/core";
import { constrainPreviewFrame, LinkPreviewPanel } from "./LinkPreviewPanel";

let root: Root, host: HTMLDivElement;
const navigate = vi.fn(),
  dismiss = vi.fn();
const preview: LinkPreview = {
  anchor: { left: 100, top: 100, width: 20, height: 20 },
  page: 7,
  image: "/original.png",
  ratio: 1.25,
  location: { type: "pdf", page: 7, x: 0.5, y: 0.3 },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  navigate.mockClear();
  dismiss.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function show(value: LinkPreview | null, key = "doc") {
  await act(async () =>
    root.render(
      <LinkPreviewPanel
        key={key}
        preview={value}
        onDismiss={dismiss}
        onNavigate={navigate}
      />,
    ),
  );
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
function pointer(node: Element, type: string, x: number, y: number) {
  node.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }),
  );
}

it("keeps a hover preview reachable while crossing to Pin, then holds the original target", async () => {
  await show(preview);
  await show(null);
  await advance(200);
  expect(button("固定预览")).not.toBeNull();
  await click("固定预览");
  await advance(500);
  await show({ ...preview, page: 9, image: "/other.png" });
  expect(document.querySelector(".link-preview-window")?.textContent).toContain(
    "第 7 页",
  );
  expect(
    document.querySelector(".link-preview-window img")?.getAttribute("src"),
  ).toBe("/original.png");
  await act(async () =>
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    ),
  );
  expect(button("关闭预览")).not.toBeNull();
  await click("跳转原文");
  expect(navigate).toHaveBeenCalledWith(preview.location);
  await click("关闭预览");
  expect(document.querySelector(".link-preview-window")).toBeNull();
  expect(dismiss).toHaveBeenCalledOnce();
});

it("dismisses an unpinned preview after leaving and resets pinned state with the document", async () => {
  await show(preview);
  await show(null);
  await advance(450);
  expect(document.querySelector(".link-preview")).toBeNull();
  await show(preview);
  await click("固定预览");
  await show(null, "another-document");
  expect(document.querySelector(".link-preview-window")).toBeNull();
});

it("keeps zoom and fit above the image after pinning a PDF link", async () => {
  await show(preview);
  await click("固定预览");
  const header = button("移动预览窗口").parentElement!;
  expect(header.contains(button("缩小预览内容"))).toBe(true);
  expect(header.contains(button("放大预览内容"))).toBe(true);
  await click("放大预览内容");
  await act(async () =>
    header.querySelector<HTMLButtonElement>('[title="适应窗口"]')!.click(),
  );
  expect(header.textContent).toContain("100%");
  expect(
    header.compareDocumentPosition(
      document.querySelector(".link-preview-viewport")!,
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("requests sharper pixels on zoom and ignores stale results after closing", async () => {
  let resolve!: (value: string) => void;
  const renderImage = vi.fn(
    (_width: number, _signal: AbortSignal) =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  await show({ ...preview, renderImage });
  await click("固定预览");
  await advance(160);
  const [firstWidth, firstSignal] = renderImage.mock.calls[0];
  await click("放大预览内容");
  expect(firstSignal.aborted).toBe(true);
  await advance(160);
  expect(renderImage.mock.calls[1][0]).toBeGreaterThan(firstWidth);
  const signal = renderImage.mock.calls[1][1];
  await click("关闭预览");
  expect(signal.aborted).toBe(true);
  await act(async () => resolve("/late.png"));
  expect(document.querySelector(".link-preview-window")).toBeNull();
});

it("moves and resizes the frame independently of content zoom, and pans enlarged content", async () => {
  await show(preview);
  await click("固定预览");
  const frame = document.querySelector<HTMLElement>(".link-preview-window")!;
  const x = parseFloat(frame.style.left),
    width = parseFloat(frame.style.width);
  const title = button("移动预览窗口");
  await act(async () => pointer(title, "pointerdown", 20, 20));
  await act(async () => pointer(title, "pointermove", 70, 40));
  await act(async () => pointer(title, "pointerup", 70, 40));
  expect(parseFloat(frame.style.left)).toBe(x + 50);
  const resize = button("调整预览窗口大小");
  await act(async () => pointer(resize, "pointerdown", 20, 20));
  await act(async () => pointer(resize, "pointermove", 100, 60));
  await act(async () => pointer(resize, "pointerup", 100, 60));
  expect(parseFloat(frame.style.width)).toBe(width + 80);
  await click("放大预览内容");
  expect(frame.textContent).toContain("125%");
  const content = document.querySelector<HTMLElement>(
    ".link-preview-viewport",
  )!;
  content.scrollLeft = 100;
  await act(async () => pointer(content, "pointerdown", 70, 40));
  await act(async () => pointer(content, "pointermove", 30, 40));
  expect(content.scrollLeft).toBe(140);
});

it("keeps a window reachable after shrinking the app viewport", () => {
  expect(
    constrainPreviewFrame(
      { x: 900, y: 700, width: 700, height: 500 },
      500,
      400,
    ),
  ).toEqual({ x: 12, y: 12, width: 476, height: 376 });
});

it("keeps the hover card open while its controls are focused or hovered", async () => {
  await show(preview);
  const card = document.querySelector(".link-preview")!;
  await act(async () =>
    card.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  await show(null);
  await advance(500);
  expect(button("固定预览")).not.toBeNull();
  await act(async () => button("固定预览").focus());
  await act(async () =>
    card.dispatchEvent(
      new MouseEvent("pointerout", {
        bubbles: true,
        relatedTarget: document.body,
      }),
    ),
  );
  await advance(500);
  expect(button("固定预览")).not.toBeNull();
});

it("closes a pinned window with Escape", async () => {
  await show(preview);
  await click("固定预览");
  await act(async () => {
    button("关闭预览").focus();
    button("关闭预览").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector(".link-preview-window")).toBeNull();
  expect(dismiss).toHaveBeenCalledOnce();
});
