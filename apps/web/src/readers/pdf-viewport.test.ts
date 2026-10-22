// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { PDFViewport } from "./pdf-viewport";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
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
it("does not overwrite its pre-resize anchor when layout has already changed before a scroll callback", () => {
  const s = setup();
  const before = s.point();
  s.size.width = 500;
  s.viewport.remember();
  s.resize();
  expect(s.point().x).toBeCloseTo(before.x);
  expect(s.point().y).toBeCloseTo(before.y);
});
