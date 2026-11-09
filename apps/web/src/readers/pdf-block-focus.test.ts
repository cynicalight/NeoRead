// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock } from "@neoread/core";
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../motion", () => ({ reducedMotion: () => motion.reduced }));
vi.mock("pdfjs-dist", () => ({
  Util: { transform: (_a: number[], b: number[]) => b },
}));
import { PDFReadingNavigation } from "./pdf-navigation";
import { PDFViewport } from "./pdf-viewport";
import { PDFResizeObserver } from "./pdf-resize";
beforeEach(() => {
  motion.reduced = false;
  vi.useFakeTimers();
});
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
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    new DOMRect(
      30 - host.scrollLeft,
      50 - host.scrollTop,
      1000 * scale,
      2600 * scale,
    );
  host.append(element);
  let geometryReads = 0;
  const nodes = [0, 1].map((n) => {
    const node = document.createElement("div");
    node.getBoundingClientRect = () => {
      geometryReads++;
      const rect = new DOMRect(
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
      const transform = element.style.transform.match(
        /translate\(([-+.\de]+)px, ([-+.\de]+)px\) scale\(([-+.\de]+)\)/,
      );
      if (!transform) return rect;
      const origin = element.style.transformOrigin.split(" ").map(parseFloat);
      const base = element.getBoundingClientRect();
      const ratio = Number(transform[3]);
      return new DOMRect(
        base.left +
          origin[0] +
          (rect.left - base.left - origin[0]) * ratio +
          Number(transform[1]),
        base.top +
          origin[1] +
          (rect.top - base.top - origin[1]) * ratio +
          Number(transform[2]),
        rect.width * ratio,
        rect.height * ratio,
      );
    };
    return node;
  });
  const focus = vi.fn(),
    anchor = vi.fn();
  const page = vi.fn(
    async () =>
      ({ getViewport: () => ({ width: 750, height: 900 }) }) as PDFPageProxy,
  );
  const viewer = {
    viewer: element,
    currentPageNumber: 1,
    refresh: vi.fn(),
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
  return {
    nav,
    host,
    size,
    viewer,
    page,
    blocks,
    focus,
    rect,
    anchor,
    element,
    geometryReads: () => geometryReads,
  };
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

function resizingFocus(fitWidth = false) {
  const s = setup();
  document.body.append(s.host);
  for (let i = 0; i < 2; i++) {
    const node = s.viewer.getPageView(i).div;
    node.className = "page";
    s.host.append(node);
  }
  s.viewer.currentScaleValue = "0.25";
  const viewport = new PDFViewport(s.host, s.viewer);
  viewport.reset();
  let resizing = false;
  s.viewer.updateScale = vi.fn(({ scaleFactor }) => {
    s.viewer.currentScaleValue = String(
      Math.round(s.viewer.currentScale * scaleFactor! * 100) / 100,
    );
    if (!resizing) viewport.scaleChanged();
  });
  let notify!: () => void;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const adapt = vi.fn(() => s.nav.resizeViewport());
  const observer = new PDFResizeObserver(
    s.host,
    () => {
      resizing = true;
      try {
        viewport.resize(fitWidth, adapt, s.nav.isNavigating);
      } finally {
        resizing = false;
      }
    },
    () => viewport.cancelAnimation(),
  );
  return {
    ...s,
    notify: () => notify(),
    adapt,
    destroy() {
      observer.disconnect();
      s.nav.destroy();
      s.host.remove();
    },
  };
}

it.each([false, true])(
  "keeps first focus zoom through a height-only resize (fit width: %s)",
  async (fitWidth) => {
    const s = resizingFocus(fitWidth);
    try {
      const first = s.nav.focusBlock("a");
      await vi.advanceTimersByTimeAsync(16);
      s.size.height -= 6;
      s.notify();
      await vi.advanceTimersByTimeAsync(144);
      expect(s.adapt).not.toHaveBeenCalled();
      expect(s.viewer.currentScale).toBe(0.25);
      expect(s.rect("a").width).toBeGreaterThan(100);
      expect(await finish(first)).toBe(true);
      expect(s.viewer.currentScale).toBe(1.42);
      centered(s, "a");
      expect(await finish(s.nav.focusBlock("a"))).toBe(true);
      expect(s.viewer.currentScale).toBe(1.42);
    } finally {
      s.destroy();
    }
  },
);

it("still interrupts focus and adapts to an actual panel width change", async () => {
  const s = resizingFocus();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(80);
    s.size.width = 400;
    s.notify();
    expect(await finish(pending)).toBe(false);
    expect(s.adapt).toHaveBeenCalledOnce();
    const calls = vi.mocked(s.viewer.updateScale).mock.calls;
    expect(calls).toHaveLength(2);
    const settledScale =
      Math.round(0.25 * calls[0][0]!.scaleFactor! * 100) / 100;
    expect(s.viewer.currentScale).toBe(
      Math.round(((settledScale * 400) / 600) * 100) / 100,
    );
  } finally {
    s.destroy();
  }
});
it("smoothly scales and centers from the first click without a mode or an initial jump", async () => {
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
    await vi.advanceTimersByTimeAsync(96);
    expect(s.viewer.currentScale).toBe(1);
    expect(s.rect("a").width).toBeGreaterThan(before.width);
    expect(s.rect("a").width).toBeLessThan(400 * 1.42);
    await finish(pending);
    expect(s.viewer.currentScale).toBe(1.42);
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
it.each(["source", "parallel"] as const)(
  "fits tall images within the %s viewport and lets a new click replace unfinished focus",
  async (mode) => {
    const s = setup();
    try {
      const first = s.nav.focusBlock("a");
      await vi.advanceTimersByTimeAsync(96);
      const before = s.rect("image");
      const second = s.nav.focusBlock("image", mode);
      expect(s.rect("image")).toEqual(before);
      await finish(second);
      await first;
      centered(s, "image");
      expect(s.rect("image").height).toBeLessThanOrEqual(s.size.height - 32);
      expect(s.rect("image").width).toBeLessThanOrEqual(s.size.width - 32);
      expect(s.focus).toHaveBeenCalledWith("image");
      expect(s.focus).toHaveBeenLastCalledWith(null);
    } finally {
      s.nav.destroy();
    }
  },
);
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

it("coalesces focus zoom into one final redraw and does not redraw on an identical second focus", async () => {
  const s = setup();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(128);
    expect(s.viewer.refresh).not.toHaveBeenCalled();
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
    await finish(pending);
    expect(s.viewer.refresh).toHaveBeenCalledTimes(1);
    expect(s.viewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      scaleFactor: 1.42,
      drawingDelay: 300,
    });
    vi.mocked(s.viewer.updateScale).mockClear();
    await finish(s.nav.focusBlock("a"));
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
    expect(s.viewer.refresh).toHaveBeenCalledTimes(1);
  } finally {
    s.nav.destroy();
  }
});

it("keeps a wide source-only block within the reading viewport", async () => {
  const s = setup();
  await finish(s.nav.focusBlock("b", "source"));
  expect(s.viewer.currentScale).toBeLessThan(1.5);
  const block = s.rect("b");
  expect(block.width).toBeLessThanOrEqual(s.size.width - 32);
  expect(block.left + block.width / 2).toBeCloseTo(30 + s.size.width / 2);
  s.size.width = 400;
  await finish(s.nav.focusBlock("b", "source"));
  expect(s.rect("b").width).toBeLessThanOrEqual(368);
});

it("does not read page geometry or update PDF layout during intermediate focus frames", async () => {
  const s = setup();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(16);
    const reads = s.geometryReads();
    const top = s.host.scrollTop,
      left = s.host.scrollLeft;
    await vi.advanceTimersByTimeAsync(160);
    expect(s.geometryReads()).toBe(reads);
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
    expect(s.host.scrollTop).toBe(top);
    expect(s.host.scrollLeft).toBe(left);
    expect(s.element.style.transform).toContain("scale(");
    await finish(pending);
    expect(s.viewer.updateScale).toHaveBeenCalledTimes(1);
    expect(s.element.style.transform).toBe("");
    expect(s.element.style.willChange).toBe("");
    centered(s, "a");
  } finally {
    s.nav.destroy();
  }
});

it("commits the visible intermediate scale once on wheel interruption and clears the visual transform", async () => {
  const s = setup();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(96);
    const visible = s.rect("a");
    s.host.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    expect(s.viewer.updateScale).toHaveBeenCalledTimes(1);
    expect(s.viewer.currentScale).toBeGreaterThan(1);
    expect(s.viewer.currentScale).toBeLessThan(1.42);
    expect(s.rect("a").width).toBeCloseTo(visible.width, -1);
    expect(s.rect("a").left).toBeCloseTo(visible.left, -1);
    expect(s.rect("a").top).toBeCloseTo(visible.top, -1);
    expect(s.element.style.transform).toBe("");
    expect(await finish(pending)).toBe(false);
    expect(s.viewer.updateScale).toHaveBeenCalledTimes(1);
  } finally {
    s.nav.destroy();
  }
});

it("applies reduced motion in one frame without a visual transform", async () => {
  motion.reduced = true;
  const s = setup();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(16);
    expect(await pending).toBe(true);
    expect(s.viewer.updateScale).toHaveBeenCalledTimes(1);
    expect(s.element.style.transform).toBe("");
    centered(s, "a");
  } finally {
    s.nav.destroy();
  }
});

it.each(["page", "anchor"])(
  "settles focus before a %s navigation takes over",
  async (kind) => {
    const s = setup();
    try {
      const pending = s.nav.focusBlock("a");
      await vi.advanceTimersByTimeAsync(96);
      const next =
        kind === "page"
          ? s.nav.goTo(2)
          : s.nav.follow({ blockId: "b", fraction: 0.5 });
      expect(s.element.style.transform).toBe("");
      expect(s.viewer.updateScale).toHaveBeenCalledTimes(1);
      await finish(next);
      expect(await pending).toBe(false);
      expect(s.viewer.updateScale).toHaveBeenCalledTimes(1);
    } finally {
      s.nav.destroy();
    }
  },
);
