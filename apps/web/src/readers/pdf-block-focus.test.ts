// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock } from "@reader/core";
vi.mock("pdfjs-dist", () => ({
  Util: { transform: (_a: number[], b: number[]) => b },
}));
import { PDFReadingNavigation } from "./pdf-navigation";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const host = document.createElement("div");
  const size = { width: 600, height: 600 };
  let scale = 1;
  Object.defineProperties(host, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
    scrollWidth: { value: 5000 },
    scrollHeight: { value: 10000 },
  });
  host.getBoundingClientRect = () =>
    new DOMRect(30, 50, size.width, size.height);
  const blocks: PDFBlock[] = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "A",
      bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
    },
    {
      id: "b",
      page: 1,
      label: "text",
      text: "B",
      bounds: { x: 0.1, y: 0.5, width: 0.8, height: 0.4 },
    },
    {
      id: "image",
      page: 2,
      label: "image",
      text: "",
      image: "figure.png",
      bounds: { x: 0.6, y: 0.2, width: 0.2, height: 0.7 },
    },
    {
      id: "footer",
      page: 2,
      label: "footer",
      text: "2",
      bounds: { x: 0.5, y: 0.95, width: 0.1, height: 0.02 },
    },
  ];
  const nodes = [0, 1].map((n) => {
    const node = document.createElement("div");
    node.getBoundingClientRect = () =>
      new DOMRect(
        30 +
          (host.classList.contains("pdf-block-reading") ? size.width / 2 : 0) -
          host.scrollLeft,
        50 +
          (host.classList.contains("pdf-block-reading") ? size.height / 2 : 0) +
          n * 1300 * scale -
          host.scrollTop,
        1000 * scale,
        1200 * scale,
      );
    return node;
  });
  const focus = vi.fn(),
    anchor = vi.fn();
  const page = vi.fn(
    async () =>
      ({ getViewport: () => ({ width: 750, height: 900 }) }) as PDFPageProxy,
  );
  const viewer = {
    currentPageNumber: 1,
    get currentScale() {
      return scale;
    },
    set currentScaleValue(value: string) {
      scale = Number(value);
    },
    updateScale: vi.fn(({ scaleFactor }: { scaleFactor: number }) => {
      scale = Math.round(scale * scaleFactor * 100) / 100;
    }),
    getPageView: (i: number) => ({ div: nodes[i] }),
  } as unknown as PDFViewer;
  const nav = new PDFReadingNavigation(
    host,
    viewer,
    page,
    () => blocks,
    { location: vi.fn(), selection: vi.fn(), readingAnchor: anchor },
    focus,
  );
  const rect = (id: string) => {
    const block = blocks.find((b) => b.id === id)!;
    const r = nodes[block.page - 1].getBoundingClientRect();
    return new DOMRect(
      r.left + block.bounds.x * r.width,
      r.top + block.bounds.y * r.height,
      block.bounds.width * r.width,
      block.bounds.height * r.height,
    );
  };
  return { nav, host, size, viewer, page, blocks, focus, rect, anchor };
}
async function finish(p: Promise<unknown>) {
  await vi.advanceTimersByTimeAsync(500);
  return p;
}
function centered(s: ReturnType<typeof setup>, id: string) {
  const r = s.rect(id),
    v = s.host.getBoundingClientRect();
  expect(r.left + r.width / 2).toBeCloseTo(v.left + v.width / 2);
  expect(r.top).toBeCloseTo(v.top + Math.max(0, (v.height - r.height) / 2));
}
it("applies scale once without an initial jump and smoothly centers from the first click", async () => {
  const s = setup();
  try {
    const before = s.rect("a");
    const pending = s.nav.focusBlock("a");
    expect(s.rect("a")).toEqual(before);
    await vi.advanceTimersByTimeAsync(16);
    expect(s.rect("a").top).toBeCloseTo(before.top);
    expect(s.rect("a").left + s.rect("a").width / 2).toBeCloseTo(
      before.left + before.width / 2,
    );
    expect(s.viewer.currentScale).toBe(1.5);
    await vi.advanceTimersByTimeAsync(96);
    expect(s.viewer.currentScale).toBe(1.5);
    expect(s.rect("a").top).toBeLessThan(before.top);
    expect(s.rect("a").top).toBeGreaterThan(120);
    await finish(pending);
    expect(s.viewer.currentScale).toBe(1.5);
    centered(s, "a");
    expect(s.focus).toHaveBeenCalledWith("a");
    expect(s.focus).toHaveBeenLastCalledWith(null);
  } finally {
    s.nav.destroy();
  }
});
it("remeasures a resized panel on every repeated click and caps automatic zoom at 200 percent", async () => {
  const s = setup();
  try {
    await finish(s.nav.focusBlock("a", "parallel"));
    expect(s.viewer.currentScale).toBeCloseTo(1.42);
    centered(s, "a");
    s.size.width = 360;
    await finish(s.nav.focusBlock("a", "parallel"));
    expect(s.viewer.currentScale).toBeCloseTo(0.82);
    centered(s, "a");
    s.size.width = 1400;
    await finish(s.nav.focusBlock("a", "parallel"));
    expect(s.viewer.currentScale).toBe(2);
    centered(s, "a");
    await finish(s.nav.focusBlock("b", "parallel"));
    expect(s.viewer.currentScale).toBe(1.71);
    centered(s, "b");
  } finally {
    s.nav.destroy();
  }
});
it("top-aligns tall images and lets a new click replace an unfinished focus", async () => {
  const s = setup();
  try {
    const first = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(96);
    const before = s.rect("image");
    const second = s.nav.focusBlock("image");
    expect(s.rect("image")).toEqual(before);
    await finish(second);
    await first;
    centered(s, "image");
    expect(s.rect("image").top).toBe(50);
    expect(s.focus).toHaveBeenCalledWith("image");
    expect(s.focus).toHaveBeenLastCalledWith(null);
  } finally {
    s.nav.destroy();
  }
});
it("cancels pending page geometry on manual zoom and uses fresh dimensions when page loading completes", async () => {
  const s = setup();
  try {
    let release!: (page: PDFPageProxy) => void;
    s.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = s.nav.focusBlock("a", "parallel");
    s.nav.stop();
    release({ getViewport: () => ({ width: 750 }) } as PDFPageProxy);
    await pending;
    expect(s.viewer.currentScale).toBe(1);
    expect(s.focus).toHaveBeenLastCalledWith(null);
    s.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const next = s.nav.focusBlock("a", "parallel");
    s.size.width = 360;
    release({ getViewport: () => ({ width: 750 }) } as PDFPageProxy);
    await finish(next);
    expect(s.viewer.currentScale).toBe(0.82);
    centered(s, "a");
  } finally {
    s.nav.destroy();
  }
});
it("leaves scrolling free after focusing, without snapping, zooming or highlighting a successor", async () => {
  const s = setup();
  try {
    await finish(s.nav.focusBlock("a"));
    const scale = s.viewer.currentScale;
    s.focus.mockClear();
    // Scroll beyond the former midpoint threshold, then across a whole page.
    for (const top of [700, 2000, 100]) {
      const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
      s.host.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(false);
      s.host.scrollTop = top;
      s.host.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(500);
      expect(s.host.scrollTop).toBe(top);
      expect(s.viewer.currentScale).toBe(scale);
    }
    expect(s.focus.mock.calls.every(([id]) => id === null)).toBe(true);
    expect(s.anchor).toHaveBeenCalled(); // position remains available for bilingual sync
  } finally {
    s.nav.destroy();
  }
});
it("cancels motion on wheel input and supports clicking again after manual zoom", async () => {
  const s = setup();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(80);
    s.host.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    const top = s.host.scrollTop;
    await finish(pending);
    expect(s.host.scrollTop).toBe(top);
    s.nav.stop();
    await finish(s.nav.focusBlock("b"));
    centered(s, "b");
    const last = s.nav.focusBlock("image");
    s.nav.destroy();
    await finish(last);
    expect(s.focus).toHaveBeenLastCalledWith(null);
  } finally {
    s.nav.destroy();
  }
});
