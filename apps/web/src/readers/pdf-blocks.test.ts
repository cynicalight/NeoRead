// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { PDFBlockOverlay, hitBlock, referenceBlock } from "./pdf-blocks";
import type { PDFBlock } from "@neoread/core";
const block: PDFBlock = {
  id: "p2-b1",
  page: 2,
  label: "chart",
  image: "assets/p2-b1.png",
  text: "",
  bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
};
it("hits normalized regions only on their source page", () => {
  expect(hitBlock([block], 2, 0.2, 0.3)?.id).toBe(block.id);
  expect(hitBlock([block], 1, 0.2, 0.3)).toBeUndefined();
  expect(hitBlock([block], 2, 0.8, 0.3)).toBeUndefined();
});
it("locates a referenced block by saved selection or source text", () => {
  const textBlock = { ...block, image: undefined, text: "A cited result." };
  expect(
    referenceBlock(
      [textBlock],
      {
        type: "pdf",
        page: 2,
        rects: [{ x: 0.12, y: 0.21, width: 0.1, height: 0.03 }],
      },
      "",
    ),
  ).toBe(textBlock);
  expect(
    referenceBlock([textBlock], { type: "pdf", page: 2 }, "A cited result."),
  ).toBe(textBlock);
  expect(
    referenceBlock([textBlock], { type: "pdf", page: 1 }, "A cited result."),
  ).toBeUndefined();
});
it("keeps the reference flash for one second and restarts it on another jump", () => {
  vi.useFakeTimers();
  try {
    const host = document.createElement("div");
    host.innerHTML = '<div class="page" data-page-number="2"></div>';
    const layer = new PDFBlockOverlay(host);
    layer.setBlocks([block]);
    layer.flashBlock(block.id);
    const flash = host.querySelector<HTMLElement>(
      ".neoread-block-reference-flash",
    )!;
    expect(flash.style.left).toBe("10%");
    expect(flash.style.height).toBe("40%");
    vi.advanceTimersByTime(500);
    layer.flashBlock(block.id);
    vi.advanceTimersByTime(999);
    expect(host.contains(flash)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(host.contains(flash)).toBe(false);
    layer.destroy();
  } finally {
    vi.useRealTimers();
  }
});
it("keeps search highlights attached to matching PDF blocks", () => {
  const host = document.createElement("div");
  host.innerHTML = '<div class="page" data-page-number="2"></div>';
  const layer = new PDFBlockOverlay(host);
  layer.setBlocks([block]);
  layer.setSearchBlocks([block.id]);
  const hit = host.querySelector<HTMLElement>(".neoread-block-search-hit")!;
  expect(hit.style.left).toBe("10%");
  expect(hit.style.height).toBe("40%");
  layer.setSearchBlocks([]);
  expect(host.querySelector(".neoread-block-search-hit")).toBeNull();
  layer.destroy();
});
it("positions the whole-block overlay and clears during selection, scroll and disposal", async () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="2"><span>text layer</span></div>';
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 1000, height: 1400 }) as DOMRect;
  const layer = new PDFBlockOverlay(host);
  layer.setBlocks([block]);
  const target = page.firstElementChild!;
  target.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 210,
      clientY: 440,
    }),
  );
  const overlay = page.querySelector<HTMLElement>(".neoread-block-hover")!;
  expect(overlay.style.left).toBe("10%");
  expect(overlay.style.height).toBe("40%");
  expect(overlay.dataset.blockId).toBe(block.id);
  expect(overlay.getAttribute("aria-hidden")).toBeNull();
  target.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      buttons: 1,
      clientX: 210,
      clientY: 440,
    }),
  );
  expect(page.querySelector(".neoread-block-hover")).toBeNull();
  target.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 210,
      clientY: 440,
    }),
  );
  host.dispatchEvent(new Event("scroll"));
  expect(page.querySelector(".neoread-block-hover")).toBeNull();
  layer.destroy();
  target.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 210,
      clientY: 440,
    }),
  );
  expect(page.querySelector(".neoread-block-hover")).toBeNull();
});

it("attaches clicks, keeps action buttons interactive, and does not attach drags", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  host.innerHTML =
    '<div class="page" data-page-number="2"><span>image</span></div>';
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(10, 20, 1000, 1400);
  const action = vi.fn();
  const layer = new PDFBlockOverlay(host, action);
  layer.setBlocks([block]);
  const target = page.firstElementChild!;
  const event = (type: string, x = 210, buttons = 0) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: 440,
        buttons,
      }),
    );
  await act(async () => {
    event("pointermove");
  });
  const explain = page.querySelector<HTMLButtonElement>(
    '[data-block-action="explain"]',
  )!;
  const preview = page.querySelector<HTMLButtonElement>(
    '[data-block-action="preview"]',
  )!;
  expect(explain).not.toBeNull();
  expect(preview).not.toBeNull();
  await act(async () => {
    explain.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, buttons: 1 }),
    );
    explain.click();
    preview.click();
  });
  expect(action.mock.calls.map((call) => call[1])).toEqual([
    "explain",
    "preview",
  ]);
  event("pointerdown");
  event("click");
  expect(action).toHaveBeenLastCalledWith(block, "attach");
  event("pointerdown");
  event("pointermove", 230, 1);
  event("click", 230);
  expect(action).toHaveBeenCalledTimes(3);
  await act(async () => layer.destroy());
  host.remove();
  vi.unstubAllGlobals();
});

it("lets a double click select PDF text before focusing", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  host.innerHTML = '<div class="page" data-page-number="2"><span>Text</span></div>';
  document.body.append(host);
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(10, 20, 1000, 1400);
  const focus = vi.fn(() => true);
  const layer = new PDFBlockOverlay(host, vi.fn(), vi.fn(), focus);
  layer.setBlocks([{ ...block, image: undefined, text: "Text" }]);
  const target = page.firstElementChild!;
  const click = (detail: number) => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 210, clientY: 440 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 210, clientY: 440, detail }));
  };
  try {
    click(1);
    expect(focus).not.toHaveBeenCalled();
    click(2);
    vi.advanceTimersByTime(500);
    expect(focus).not.toHaveBeenCalled();
    click(1);
    vi.advanceTimersByTime(149);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(focus).toHaveBeenCalledOnce();
    focus.mockClear();
    click(1);
    host.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(500);
    expect(focus).not.toHaveBeenCalled();
  } finally {
    act(() => layer.destroy());
    host.remove();
    vi.useRealTimers();
  }
});

it("reports source hover and paints a passive counterpart without feeding hover back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="2"><span>Text</span></div>';
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(10, 20, 1000, 1400);
  const hover = vi.fn();
  const layer = new PDFBlockOverlay(host, vi.fn(), hover);
  layer.setBlocks([block]);
  const target = page.firstElementChild!;
  await act(async () =>
    target.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 210,
        clientY: 440,
      }),
    ),
  );
  expect(hover).toHaveBeenLastCalledWith(block);
  host.dispatchEvent(new Event("pointerleave"));
  expect(hover).toHaveBeenLastCalledWith(null);
  hover.mockClear();
  layer.setLinkedBlock(block.id);
  const counterpart = page.querySelector<HTMLElement>(
    ".neoread-block-counterpart",
  )!;
  expect(counterpart.dataset.blockId).toBe(block.id);
  expect(counterpart.style.left).toBe("10%");
  expect(counterpart.style.height).toBe("40%");
  expect(counterpart.children).toHaveLength(0);
  expect(hover).not.toHaveBeenCalled();
  counterpart.remove();
  layer.repaint();
  expect(page.contains(counterpart)).toBe(true);
  layer.setLinkedBlock(null);
  expect(page.contains(counterpart)).toBe(false);
  await act(async () => layer.destroy());
  vi.unstubAllGlobals();
});

it("excludes page furniture from hover while keeping footnotes interactive", () => {
  for (const label of [
    "header",
    "footer",
    "number",
    "header_image",
    "footer_image",
  ])
    expect(hitBlock([{ ...block, label }], 2, 0.2, 0.3)).toBeUndefined();
  const footnote = {
    ...block,
    image: undefined,
    text: "1 Important note",
    label: "footnote",
    bounds: { x: 0.1, y: 0.94, width: 0.7, height: 0.02 },
  };
  expect(hitBlock([footnote], 2, 0.2, 0.95)?.id).toBe(footnote.id);
  const pageNumber = {
    ...footnote,
    text: "12",
    label: "text",
    bounds: { x: 0.48, y: 0.95, width: 0.04, height: 0.02 },
  };
  expect(hitBlock([pageNumber], 2, 0.5, 0.96)).toBeUndefined();
});

it("shows passive feedback during positioning, fades it on completion and keeps hover actions separate", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="2"><span>Text</span></div>';
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(10, 20, 1000, 1400);
  const text = { ...block, image: undefined, label: "text", text: "Paragraph" };
  const layer = new PDFBlockOverlay(host);
  layer.setBlocks([text]);
  layer.setFocusBlock(text.id);
  const outline = () => page.querySelector<HTMLElement>(".neoread-block-focus");
  expect(outline()?.dataset.blockId).toBe(text.id);
  expect(outline()?.children).toHaveLength(0);
  expect(page.querySelector("[data-block-action]")).toBeNull();
  await act(async () =>
    page.firstElementChild!.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 210,
        clientY: 440,
      }),
    ),
  );
  expect(page.querySelector('[data-block-action="explain"]')).not.toBeNull();
  expect(page.querySelector('[data-block-action="translate"]')).toBeNull();
  expect(outline()).toBeNull(); // no double tint on the same block
  host.dispatchEvent(new Event("scroll"));
  expect(outline()?.children).toHaveLength(0);
  expect(page.querySelector("[data-block-action]")).toBeNull();
  host.dispatchEvent(new Event("pointerleave"));
  expect(outline()?.dataset.blockId).toBe(text.id);
  layer.setFocusBlock(null);
  expect(outline()?.hasAttribute("data-fading")).toBe(true);
  outline()!.dispatchEvent(new Event("animationend"));
  expect(outline()).toBeNull();
  await act(async () => layer.destroy());
  vi.unstubAllGlobals();
});

it("focuses text and image clicks without attaching images, and leaves drags and links alone", async () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="2"><span>Text</span><a href="#note">Link</a></div>';
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(10, 20, 1000, 1400);
  const focus = vi.fn(() => true),
    action = vi.fn();
  const layer = new PDFBlockOverlay(host, action, vi.fn(), focus);
  const target = page.firstElementChild!;
  const click = (target: Element, endX = 210) => {
    target.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 210,
        clientY: 440,
      }),
    );
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: endX, clientY: 440 }),
    );
  };
  layer.setBlocks([block]);
  click(target);
  expect(focus).toHaveBeenLastCalledWith(block);
  expect(action).not.toHaveBeenCalled();
  const text = { ...block, image: undefined, label: "text", text: "Paragraph" };
  layer.setBlocks([text]);
  click(target);
  expect(focus).toHaveBeenLastCalledWith(text);
  click(target, 250);
  click(page.querySelector("a")!);
  expect(focus).toHaveBeenCalledTimes(2);
  layer.destroy();
});

it("keeps the block during fade-out and cancels stale removal when the pointer returns", async () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="2"><span>text</span></div>';
  const page = host.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 1000);
  const layer = new PDFBlockOverlay(host);
  layer.setBlocks([block]);
  const move = () =>
    page.firstElementChild!.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 200,
        clientY: 300,
      }),
    );
  await act(async () => {
    move();
  });
  const overlay = page.querySelector<HTMLElement>(".neoread-block-hover")!;
  let finish!: () => void;
  const cancel = vi.fn();
  overlay.animate = vi.fn(() => ({
    finished: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    cancel,
  })) as unknown as typeof overlay.animate;
  host.dispatchEvent(new Event("pointerleave"));
  expect(page.contains(overlay)).toBe(true);
  expect(overlay.inert).toBe(true);
  await act(async () => {
    move();
    finish();
    await Promise.resolve();
  });
  expect(cancel).toHaveBeenCalled();
  expect(page.contains(overlay)).toBe(true);
  expect(overlay.inert).toBe(false);
  layer.setBlocks([{ ...block }]);
  expect(page.contains(overlay)).toBe(true);
  host.dispatchEvent(new Event("pointerleave"));
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(page.contains(overlay)).toBe(false);
  await act(async () => layer.destroy());
});

it("keeps a non-intercepting tour landmark and distinguishes a click from automatic focus", () => {
  const host = document.createElement("div");
  host.innerHTML = '<div class="page" data-page-number="2"></div>';
  const onFocus = vi.fn(() => true);
  const layer = new PDFBlockOverlay(host, undefined, undefined, onFocus);
  const paragraph = {
    ...block,
    image: undefined,
    label: "text",
    text: "A paragraph ".repeat(12),
  };
  layer.setBlocks([paragraph]);
  const target = host.querySelector<HTMLElement>('[data-tour="source-block"]')!;
  expect(target.style.pointerEvents).toBe("none");
  expect(target.style.left).toBe("10%");
  layer.setFocusBlock(paragraph.id);
  expect(target.dataset.focused).toBe("true");
  expect(target.dataset.demonstrated).toBeUndefined();
  target.click();
  expect(onFocus).toHaveBeenCalledWith(paragraph);
  expect(target.dataset.demonstrated).toBe("true");
  layer.setBlocks([]);
  expect(host.contains(target)).toBe(false);
  layer.destroy();
});
