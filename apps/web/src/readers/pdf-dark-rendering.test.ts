// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@neoread/core";
import { readFileSync } from "node:fs";

const styles = readFileSync("apps/web/src/style.css", "utf8");

const fixture = vi.hoisted(() => ({
  currentPage: 1,
  cachedPages: undefined as number[] | undefined,
  dispatch: undefined as ((name: string, event?: unknown) => void) | undefined,
  reset: vi.fn(),
  cleanup: vi.fn(),
  opened: vi.fn(),
  render: vi.fn(),
  update: vi.fn(),
  queue: undefined as
    { renderHighestPriority: (...args: unknown[]) => void } | undefined,
  refresh: vi.fn(),
  diagnostic: vi.fn(),
  viewerOptions: undefined as Record<string, unknown> | undefined,
  documentOptions: undefined as Record<string, unknown> | undefined,
}));
vi.mock("../diagnostics", () => ({ reportDiagnostic: fixture.diagnostic }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: (options: Record<string, unknown>) => {
    fixture.opened();
    fixture.documentOptions = options;
    return {
      promise: Promise.resolve({ numPages: 1 }),
      destroy: vi.fn(),
    };
  },
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
      this.listeners.get(name)?.forEach((callback) => callback(event));
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    pagesCount = 1;
    renderingQueue = { renderHighestPriority: fixture.render };
    currentScale = 1;
    get currentPageNumber() {
      return fixture.currentPage;
    }
    currentScaleValue = "page-width";
    constructor(options: Record<string, unknown>) {
      fixture.viewerOptions = options;
      fixture.queue = this.renderingQueue;
    }
    setDocument(doc: unknown) {
      if (doc) fixture.dispatch!("pagesinit");
    }
    getPageView() {
      return {
        id: fixture.currentPage,
        reset: fixture.reset,
        renderingState: 3,
        pdfPage: { cleanup: fixture.cleanup },
      };
    }
    getCachedPageViews() {
      return new Set(
        (fixture.cachedPages ?? [fixture.currentPage]).map((id) => ({
          ...this.getPageView(),
          id,
          reset: () => fixture.reset(id),
          pdfPage: { cleanup: () => fixture.cleanup(id) },
        })),
      );
    }
    refresh = fixture.refresh;
    update = fixture.update;
  },
}));

import { PDFReaderAdapter } from "./pdf";
let host: HTMLDivElement;
let adapter: PDFReaderAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset.mockReset();
  fixture.cachedPages = undefined;
  fixture.currentPage = 1;
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
    location: vi.fn(),
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

it("loads PDF ranges on demand with upstream canvas limits and rendering defaults", async () => {
  await adapter.open(doc);
  expect(fixture.documentOptions).toMatchObject({
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
  });
  expect(fixture.viewerOptions).toMatchObject({
    maxCanvasPixels: 4 * 1024 * 1024,
    maxCanvasDim: 4096,
  });
  expect(fixture.documentOptions).not.toHaveProperty("enableHWA");
  expect(fixture.viewerOptions).not.toHaveProperty("preRenderViewports");
});

it("does not revisit page overlays for detail canvas updates", async () => {
  await adapter.open(doc);
  const query = vi.spyOn(host, "querySelectorAll");
  fixture.dispatch!("pagerendered", { pageNumber: 1, isDetailView: true });
  expect(query).not.toHaveBeenCalled();
  fixture.dispatch!("pagerendered", { pageNumber: 1 });
  expect(query).toHaveBeenCalledWith('.page[data-page-number="1"]');
});

it("keeps rendered pages when switching tabs and pauses background drawing without reopening the PDF", async () => {
  await adapter.open(doc);
  const page = document.createElement("div");
  page.className = "page";
  const canvas = document.createElement("canvas");
  page.append(canvas);
  host.querySelector(".pdfViewer")!.append(page);
  fixture.reset.mockImplementation(() => page.replaceChildren());
  const location = adapter.getLocation();
  adapter.setVisible(false);
  expect(host.querySelector("canvas")).toBe(canvas);
  expect(fixture.reset).not.toHaveBeenCalled();
  expect(fixture.cleanup).not.toHaveBeenCalled();
  fixture.queue!.renderHighestPriority();
  expect(fixture.render).not.toHaveBeenCalled();
  adapter.setVisible(false);
  expect(fixture.reset).not.toHaveBeenCalled();
  adapter.setVisible(true);
  expect(fixture.update).toHaveBeenCalledOnce();
  fixture.queue!.renderHighestPriority();
  expect(fixture.render).toHaveBeenCalledOnce();
  expect(adapter.getLocation()).toEqual(location);
  expect(fixture.opened).toHaveBeenCalledOnce();
  expect(host.querySelector("canvas")).toBe(canvas);
  await adapter.destroy();
  expect(host.querySelector("canvas")).toBeNull();
});

it("keeps only the current page and neighbors in a hidden reader", async () => {
  fixture.currentPage = 3;
  fixture.cachedPages = [1, 2, 3, 4, 5];
  await adapter.open(doc);
  adapter.setVisible(false);
  expect(fixture.reset.mock.calls).toEqual([[1], [5]]);
  expect(fixture.cleanup.mock.calls).toEqual([[1], [5]]);
});

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
