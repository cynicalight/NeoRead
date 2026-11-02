// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@neoread/core";
import { readFileSync } from "node:fs";

const styles = readFileSync("apps/web/src/style.css", "utf8");

const fixture = vi.hoisted(() => ({
  location: vi.fn(),
  pages: 1,
  currentPage: 1,
  page: undefined as HTMLElement | undefined,
  visiblePages: undefined as
    { id: number; view: { div: HTMLElement } }[] | undefined,
  dispatch: undefined as ((name: string, event?: unknown) => void) | undefined,
  reset: vi.fn(),
  refresh: vi.fn(),
  diagnostic: vi.fn(),
  viewerOptions: undefined as Record<string, unknown> | undefined,
}));
vi.mock("../diagnostics", () => ({ reportDiagnostic: fixture.diagnostic }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: fixture.pages }),
    destroy: vi.fn(),
  }),
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, Set<(event?: unknown) => void>>();
    constructor() {
      fixture.dispatch = this.dispatch.bind(this);
    }
    on(name: string, callback: (event?: unknown) => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(callback);
    }
    off(name: string, callback: (event?: unknown) => void) {
      this.listeners.get(name)?.delete(callback);
    }
    dispatch(name: string, event?: unknown) {
      if (name === "pagechanging")
        fixture.currentPage = (event as { pageNumber: number }).pageNumber;
      this.listeners.get(name)?.forEach((callback) => callback(event));
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    currentScale = 1;
    currentScaleValue = "page-width";
    constructor(options: Record<string, unknown>) {
      fixture.viewerOptions = options;
    }
    setDocument(doc: unknown) {
      if (doc) fixture.dispatch!("pagesinit");
    }
    getPageView() {
      return { reset: fixture.reset, div: fixture.page };
    }
    _getVisiblePages() {
      return {
        views:
          fixture.visiblePages ??
          (fixture.page
            ? [{ id: fixture.currentPage, view: { div: fixture.page } }]
            : []),
      };
    }
    refresh = fixture.refresh;
  },
}));

import { PDFReaderAdapter } from "./pdf";
let host: HTMLDivElement;
let adapter: PDFReaderAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.pages = 1;
  fixture.currentPage = 1;
  fixture.page = undefined;
  fixture.visiblePages = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "Worker",
    vi.fn(() => {
      throw new Error("No pixel worker allowed");
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  adapter = new PDFReaderAdapter(host, {
    location: fixture.location,
    selection: vi.fn(),
  });
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const doc = { id: "test", type: "pdf" } as Document;

it("uses object colors and never reads back or hides a completed canvas", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open(doc);
  const canvas = document.createElement("canvas");
  host.append(canvas);
  const readback = vi.spyOn(canvas, "getContext");
  fixture.dispatch!("pagerendered", { pageNumber: 1, source: { canvas } });
  expect(readback).not.toHaveBeenCalled();
  expect(Worker).not.toHaveBeenCalled();
  expect(styles).not.toContain("canvas:not([data-pdf-dark-ready])");
  expect(canvas.style.visibility).not.toBe("hidden");
});

it("does not reset canvases for repeated themes or incoming analysis blocks", async () => {
  const dark = { ...defaultTheme, mode: "dark" as const };
  adapter.preferTheme(dark);
  await adapter.open(doc);
  fixture.refresh.mockClear();
  await adapter.setTheme(dark);
  adapter.setBlocks([
    {
      id: "figure",
      page: 1,
      label: "image",
      text: "",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    },
  ]);
  await adapter.setTheme({ ...dark, pdfDarkImageMode: "invert" });
  expect(fixture.reset).not.toHaveBeenCalled();
  expect(fixture.refresh).not.toHaveBeenCalled();
});

it("refreshes once on palette changes without discarding completed canvases", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open(doc);
  fixture.refresh.mockClear();
  await adapter.setTheme({
    ...defaultTheme,
    mode: "dark",
    pdfDarkContrast: "high",
  });
  expect(fixture.reset).not.toHaveBeenCalled();
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith(false, {
    pageColors: expect.objectContaining({
      background: "#000000",
      foreground: "#ffffff",
      mapColor: expect.any(Function),
    }),
  });
  await adapter.setTheme({ ...defaultTheme, mode: "light" });
  expect(fixture.refresh).toHaveBeenLastCalledWith(false, { pageColors: null });
});

it("reports only the first failed render with bounded metadata", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open(doc);
  fixture.dispatch!("pagerendered", {
    pageNumber: 1,
    isDetailView: true,
    error: new Error("private document text"),
  });
  fixture.dispatch!("pagerendered", {
    pageNumber: 1,
    error: new Error("repeat"),
  });
  expect(fixture.diagnostic).toHaveBeenCalledExactlyOnceWith({
    level: "error",
    event: "pdf.render.failed",
    detail: "pipeline=object-colors; layer=detail",
  });
});

it("reports the visible page extent during ordinary scroll while keeping the restore location at the viewport top", async () => {
  fixture.pages = 10;
  Object.defineProperty(host, "clientWidth", { value: 800 });
  Object.defineProperty(host, "clientHeight", { value: 500 });
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  const page = document.createElement("div");
  host.append(page);
  fixture.page = page;
  let top = -200;
  vi.spyOn(page, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, top, 800, 1000),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  await adapter.open(doc);
  fixture.dispatch!("pagechanging", { pageNumber: 10 });
  fixture.location.mockClear();
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(fixture.location).toHaveBeenCalled());
  expect(fixture.location.mock.lastCall?.[0]).toMatchObject({
    type: "pdf",
    page: 10,
    y: 0.2,
  });
  expect(fixture.location.mock.lastCall?.[2]).toBeCloseTo(9.7);
  top = -500;
  fixture.location.mockClear();
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(fixture.location).toHaveBeenCalled());
  expect(fixture.location.mock.lastCall?.[0]).toMatchObject({
    page: 10,
    y: 0.5,
  });
  expect(fixture.location.mock.lastCall?.[2]).toBe(10);
  const lastPage = document.createElement("div");
  let lastTop = 350;
  lastPage.getBoundingClientRect = () => new DOMRect(0, lastTop, 800, 300);
  fixture.visiblePages = [
    { id: 10, view: { div: lastPage } },
    { id: 9, view: { div: page } },
  ];
  fixture.dispatch!("pagechanging", { pageNumber: 9 });
  fixture.location.mockClear();
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(fixture.location).toHaveBeenCalled());
  expect(fixture.location.mock.lastCall?.[0]).toMatchObject({
    page: 9,
    y: 0.5,
  });
  expect(fixture.location.mock.lastCall?.[2]).toBe(9.5);
  lastTop = 200;
  fixture.location.mockClear();
  host.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(fixture.location).toHaveBeenCalled());
  expect(fixture.location.mock.lastCall?.[0]).toMatchObject({
    page: 9,
    y: 0.5,
  });
  expect(fixture.location.mock.lastCall?.[2]).toBe(10);
});
