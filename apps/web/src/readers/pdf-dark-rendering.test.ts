// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@neoread/core";
import { readFileSync } from "node:fs";

const styles = readFileSync("apps/web/src/style.css", "utf8");

const fixture = vi.hoisted(() => ({
  dispatch: undefined as ((name: string, event?: unknown) => void) | undefined,
  reset: vi.fn(),
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
    currentScaleValue = "page-width";
    constructor(options: Record<string, unknown>) {
      fixture.viewerOptions = options;
      fixture.queue = this.renderingQueue;
    }
    setDocument(doc: unknown) {
      if (doc) fixture.dispatch!("pagesinit");
    }
    getPageView() {
      return { reset: fixture.reset, renderingState: 3 };
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

it("loads PDF ranges on demand and uses hardware canvas acceleration within the existing limits", async () => {
  await adapter.open(doc);
  expect(fixture.documentOptions).toMatchObject({
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
    enableHWA: true,
  });
  expect(fixture.viewerOptions).toMatchObject({
    maxCanvasPixels: 4 * 1024 * 1024,
    maxCanvasDim: 4096,
    preRenderViewports: 1,
  });
});

it("does not revisit page overlays for detail canvas updates", async () => {
  await adapter.open(doc);
  const query = vi.spyOn(host, "querySelectorAll");
  fixture.dispatch!("pagerendered", { pageNumber: 1, isDetailView: true });
  expect(query).not.toHaveBeenCalled();
  fixture.dispatch!("pagerendered", { pageNumber: 1 });
  expect(query).toHaveBeenCalledWith('.page[data-page-number="1"]');
});

it("releases hidden canvases and pauses rendering until the reader is visible again", async () => {
  await adapter.open(doc);
  const location = adapter.getLocation();
  adapter.setVisible(false);
  expect(fixture.reset).toHaveBeenCalledOnce();
  fixture.queue!.renderHighestPriority();
  expect(fixture.render).not.toHaveBeenCalled();
  adapter.setVisible(false);
  expect(fixture.reset).toHaveBeenCalledOnce();
  adapter.setVisible(true);
  expect(fixture.update).toHaveBeenCalledOnce();
  fixture.queue!.renderHighestPriority();
  expect(fixture.render).toHaveBeenCalledOnce();
  expect(adapter.getLocation()).toEqual(location);
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
