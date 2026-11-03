// @vitest-environment jsdom
import { useReaderStore } from "../store";
import { afterEach, expect, it, vi } from "vitest";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { PDFViewport } from "./pdf-viewport";
afterEach(() => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(initial = 1.6) {
  const host = document.createElement("div");
  document.body.append(host);
  const size = { width: 800, height: 600 };
  let scale = initial;
  let insetX = size.width / 2,
    insetY = size.height / 2;
  Object.defineProperties(host, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  host.getBoundingClientRect = () =>
    new DOMRect(30, 50, size.width, size.height);
  const pages = [0, 1, 2].map((index) => {
    const page = document.createElement("div");
    page.className = "page";
    host.append(page);
    page.getBoundingClientRect = () =>
      new DOMRect(
        30 + insetX - host.scrollLeft,
        50 + insetY + index * (1200 * scale + 20) - host.scrollTop,
        1000 * scale,
        1200 * scale,
      );
    return page;
  });
  const viewer = {
    currentPageNumber: 2,
    getPageView: (n: number) => (pages[n] ? { div: pages[n] } : undefined),
    get currentScale() {
      return scale;
    },
    set currentScaleValue(value: string) {
      scale = value === "page-width" ? size.width / 1000 : Number(value);
    },
    updateScale: ({ scaleFactor }: { scaleFactor: number }) => {
      scale = Math.round(scale * scaleFactor * 100) / 100;
    },
  } as unknown as PDFViewer;
  host.scrollLeft = 320;
  host.scrollTop = 2200;
  const viewport = new PDFViewport(host, viewer);
  viewport.reset();
  const resize = () =>
    viewport.resize(false, () => {
      insetX = size.width / 2;
      insetY = size.height / 2;
    });
  const point = () => {
    const r = pages[1].getBoundingClientRect();
    return {
      x: (30 + size.width / 2 - r.left) / r.width,
      y: (50 + size.height / 2 - r.top) / r.height,
    };
  };
  return { host, size, viewer, viewport, resize, point };
}
it("adapts source to parallel width and scales horizontal panning while preserving the same PDF point", () => {
  const s = setup(),
    before = s.point();
  s.size.width = 400;
  s.resize();
  expect(s.viewer.currentScale).toBe(0.8);
  expect(s.host.scrollLeft).toBeCloseTo(160);
  expect(s.point().x).toBeCloseTo(before.x);
  expect(s.point().y).toBeCloseTo(before.y);
  s.size.width = 800;
  s.resize();
  expect(s.viewer.currentScale).toBe(1.6);
  expect(s.host.scrollLeft).toBeCloseTo(320);
  expect(s.point().y).toBeCloseTo(before.y);
});
it("does not accumulate rounding or clamp drift across repeated resizes", () => {
  const s = setup(4),
    before = s.point();
  for (let i = 0; i < 20; i++) {
    s.size.width = 1600;
    s.resize();
    s.size.width = 407;
    s.resize();
  }
  s.size.width = 800;
  s.resize();
  expect(s.viewer.currentScale).toBe(4);
  expect(s.point().x).toBeCloseTo(before.x);
  expect(s.point().y).toBeCloseTo(before.y);
});
it("uses the newest manual zoom as its next resize basis and ignores hidden zero-size panes", () => {
  const s = setup();
  s.size.width = 400;
  s.resize();
  s.viewer.currentScaleValue = "2";
  s.viewport.reset();
  const before = s.point();
  s.host.setAttribute("inert", "");
  s.size.width = 0;
  expect(s.resize()).toBeUndefined();
  s.host.removeAttribute("inert");
  s.size.width = 600;
  s.resize();
  expect(s.viewer.currentScale).toBe(3);
  expect(s.point().x).toBeCloseTo(before.x);
  expect(s.point().y).toBeCloseTo(before.y);
});
it("keeps explicit fit-width mode and preserves the reading point when height changes", () => {
  const s = setup();
  const before = s.point();
  s.size.height = 500;
  s.resize();
  expect(s.viewer.currentScale).toBe(1.6);
  expect(s.point().y).toBeCloseTo(before.y);
  s.size.width = 400;
  s.viewport.resize(true, () => {});
  expect(s.viewer.currentScale).toBe(0.4);
});
it("does not take over a height change during navigation before the next scale event", () => {
  const s = setup(0.25);
  s.viewer.currentScaleValue = "1.37";
  s.size.height -= 6;
  const adapt = vi.fn();
  const scroll = { left: s.host.scrollLeft, top: s.host.scrollTop };
  expect(s.viewport.resize(false, adapt, true)).toBeUndefined();
  expect(adapt).not.toHaveBeenCalled();
  expect(s.viewer.currentScale).toBe(1.37);
  expect(s.host.scrollLeft).toBe(scroll.left);
  expect(s.host.scrollTop).toBe(scroll.top);
  s.size.width = 400;
  s.viewport.resize(false, adapt, true);
  expect(adapt).toHaveBeenCalledOnce();
  expect(s.viewer.currentScale).toBe(0.69);
});
it("records a zoom as the resize basis even when available height has changed", () => {
  const s = setup();
  s.size.width = 400;
  s.resize();
  s.viewer.currentScaleValue = "1.5";
  s.size.height -= 6;
  s.viewport.scaleChanged();
  s.size.width = 800;
  s.resize();
  expect(s.viewer.currentScale).toBe(3);
});
it("does not overwrite its pre-resize anchor when layout has already changed before a scroll callback", () => {
  const s = setup();
  const before = s.point();
  s.size.width = 500;
  s.viewport.remember();
  s.resize();
  expect(s.point().x).toBeCloseTo(before.x);
  expect(s.point().y).toBeCloseTo(before.y);
});

it("commits scale once and animates presentation without recapturing intermediate geometry", () => {
  const s = setup();
  const element = document.createElement("div");
  s.host.append(element);
  const animation = { cancel: vi.fn(), onfinish: null };
  const animate = vi.fn(() => animation);
  Object.defineProperty(element, "animate", { value: animate });
  s.viewer.viewer = element;
  const update = vi.spyOn(s.viewer, "updateScale");
  s.size.width = 400;
  s.resize();
  expect(update).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate.mock.calls[0]).toMatchObject([
    [
      { transform: expect.stringContaining("scale(2)") },
      { transform: "translate(0px, 0px) scale(1)" },
    ],
    { duration: 160 },
  ]);
  const measure = vi.spyOn(s.host, "getBoundingClientRect");
  measure.mockClear();
  s.viewport.remember();
  expect(measure).not.toHaveBeenCalled();
  s.viewport.cancelAnimation();
  expect(animation.cancel).toHaveBeenCalledTimes(1);
});
it("applies the final scale without animation for reduced motion", () => {
  const s = setup();
  const element = document.createElement("div");
  const animate = vi.fn();
  Object.defineProperty(element, "animate", { value: animate });
  s.viewer.viewer = element;
  useReaderStore.getState().setTheme({ reducedMotion: true });
  try {
    s.size.width = 400;
    s.resize();
    expect(s.viewer.currentScale).toBe(0.8);
    expect(animate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("preserves the reading point on native maximize and restore without a second scale animation", () => {
  const s = setup();
  const point = s.point();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const element = document.createElement("div");
  const animate = vi.fn();
  Object.defineProperty(element, "animate", { value: animate });
  s.viewer.viewer = element;
  const scale = vi.spyOn(s.viewer, "updateScale");

  vi.stubGlobal("innerWidth", width + 600);
  vi.stubGlobal("innerHeight", height + 300);
  s.size.width = 1200;
  s.size.height = 900;
  s.resize();
  expect(s.viewer.currentScale).toBeCloseTo(2.4);
  expect(s.point().x).toBeCloseTo(point.x);
  expect(s.point().y).toBeCloseTo(point.y);

  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  s.size.width = 800;
  s.size.height = 600;
  s.resize();
  expect(s.viewer.currentScale).toBeCloseTo(1.6);
  expect(s.point().x).toBeCloseTo(point.x);
  expect(s.point().y).toBeCloseTo(point.y);
  expect(scale).toHaveBeenCalledTimes(2);
  expect(animate).not.toHaveBeenCalled();
});

async function renderingWindow(heights: number[], top: number, height: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("pdfjsLib", await import("pdfjs-dist"));
  const { PDFViewer: NativePDFViewer, RenderingStates } =
    await import("pdfjs-dist/web/pdf_viewer.mjs");
  const host = document.createElement("div"),
    element = document.createElement("div");
  host.append(element);
  document.body.append(host);
  const size = { height };
  Object.defineProperties(host, {
    clientHeight: { get: () => size.height },
    clientWidth: { value: 800 },
  });
  host.scrollTop = top;
  const viewer = new NativePDFViewer({
    container: host,
    viewer: element,
    eventBus: { on() {} },
    l10n: {},
    preRenderViewports: 1,
  } as unknown as ConstructorParameters<typeof NativePDFViewer>[0]);
  let offset = 0;
  const pages = heights.map((height, index) => {
    const div = document.createElement("div"),
      pageTop = offset;
    offset += height;
    element.append(div);
    Object.defineProperties(div, {
      offsetTop: { value: pageTop },
      offsetLeft: { value: 0 },
      clientHeight: { value: height },
      clientWidth: { value: 800 },
    });
    return {
      id: index + 1,
      renderingId: `page-${index + 1}`,
      div,
      pdfPage: {},
      renderingState: RenderingStates.INITIAL,
    };
  });
  Reflect.set(viewer, "_pages", pages);
  const ids = (window: object) => [...(window as { ids: Set<number> }).ids];
  return { viewer, host, pages, size, ids, RenderingStates };
}

it.each([
  {
    heights: Array(20).fill(100),
    top: 650,
    visible: [7, 8, 9],
    prepared: [5, 6, 7, 8, 9, 10, 11],
  },
  {
    heights: Array(20).fill(100),
    top: 0,
    visible: [1, 2],
    prepared: [1, 2, 3, 4],
  },
  {
    heights: [50, 400, 80, 50, 50, 600, 80, 80],
    top: 450,
    visible: [3, 4, 5, 6],
    prepared: [2, 3, 4, 5, 6],
  },
])(
  "prepares one viewport above and below without changing visible-page reporting at $top",
  async ({ heights, top, visible, prepared }) => {
    const s = await renderingWindow(heights, top, 200);
    expect(s.ids(s.viewer._getVisiblePages())).toEqual(visible);
    expect(s.ids(s.viewer._getVisiblePages(1))).toEqual(prepared);
    expect(s.ids(s.viewer._getVisiblePages())).toEqual(visible);
  },
);

it.each([true, false])(
  "renders the current viewport, the full preparation window and then detail tiles when scrolling down=%s",
  async (down) => {
    const s = await renderingWindow(Array(20).fill(100), 650, 200);
    s.viewer.scroll.down = down;
    s.pages[6].renderingState = s.pages[8].renderingState =
      s.RenderingStates.FINISHED;
    const detail = { ...s.pages[7], renderingId: "detail-8" };
    Reflect.set(s.pages[7], "detailView", detail);
    const render = vi
      .spyOn(s.viewer.renderingQueue!, "renderView")
      .mockReturnValue(true);
    const sequence = [
      "page-8",
      ...(down
        ? ["page-10", "page-11", "page-6", "page-5"]
        : ["page-6", "page-5", "page-10", "page-11"]),
      "detail-8",
    ];
    for (const renderingId of sequence) {
      expect(s.viewer.forceRendering(s.viewer._getVisiblePages())).toBe(true);
      await Promise.resolve();
      const selected = render.mock.lastCall![0];
      expect(selected.renderingId).toBe(renderingId);
      selected.renderingState = s.RenderingStates.FINISHED;
    }
    expect(s.viewer.forceRendering(s.viewer._getVisiblePages())).toBe(false);
  },
);

it("recalculates the prepared area when the viewport height changes", async () => {
  const s = await renderingWindow(Array(20).fill(100), 650, 200);
  s.size.height = 100;
  expect(s.ids(s.viewer._getVisiblePages(1))).toEqual([6, 7, 8, 9]);
});

it("skips a late page load outside the new preparation window after fast scrolling", async () => {
  const s = await renderingWindow(Array(20).fill(100), 650, 200);
  s.pages.forEach((page) => {
    page.renderingState = s.RenderingStates.FINISHED;
  });
  const late = s.pages[7];
  late.renderingState = s.RenderingStates.INITIAL;
  Reflect.set(late, "pdfPage", undefined);
  Reflect.set(late, "setPdfPage", (page: object) => {
    late.pdfPage = page;
  });
  let complete!: (page: object) => void;
  Reflect.set(s.viewer, "pdfDocument", {
    getPage: () =>
      new Promise<object>((resolve) => {
        complete = resolve;
      }),
  });
  const render = vi
    .spyOn(s.viewer.renderingQueue!, "renderView")
    .mockReturnValue(true);
  expect(s.viewer.forceRendering(s.viewer._getVisiblePages())).toBe(true);
  s.host.scrollTop = 1450;
  s.pages[15].renderingState = s.RenderingStates.INITIAL;
  complete({});
  await vi.waitFor(() => expect(render).toHaveBeenCalledWith(s.pages[15]));
  expect(render).not.toHaveBeenCalledWith(late);
});
