// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { Annotation, PDFBlock, ReaderSelection } from "@neoread/core";
type Bus = { dispatch(name: string, event?: { pageNumber: number }): void };
const viewer = vi.hoisted(() => ({ bus: undefined as undefined | Bus }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, Set<(event?: unknown) => void>>();
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
    constructor(options: { eventBus: Bus }) {
      viewer.bus = options.eventBus;
    }
    // A 600 x 800 pt page, laid out by PDF.js in its unrotated frame.
    getPageView() {
      return { viewport: { rawDims: { pageWidth: 600, pageHeight: 800 } } };
    }
    setDocument() {}
  },
}));
import { PDFReaderAdapter } from "./pdf";

let adapter: PDFReaderAdapter;
let host: HTMLDivElement;
let selection: Mock<(selection: ReaderSelection | null) => void>;
const scan = (lines = ["Scanned line one", "Scanned line two"]): PDFBlock => ({
  id: "scan",
  page: 1,
  label: "text",
  bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
  text: lines.join(" "),
  ocr: true,
  ocrLines: lines.map((text, i) => ({
    text,
    bounds: { x: 0.1, y: 0.1 + i * 0.04, width: 0.5 + i * 0.1, height: 0.025 },
  })),
});
function renderTextLayer(rotation = 0) {
  host.querySelector(".pdfViewer")!.innerHTML =
    `<div class="page" data-page-number="1"><div class="textLayer" data-main-rotation="${rotation}"><span>Native header</span><br><div class="endOfContent"></div></div></div>`;
  vi.spyOn(
    host.querySelector(".page")!,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(20, 40, 600, 800));
  viewer.bus!.dispatch("textlayerrendered", { pageNumber: 1 });
  return host.querySelector<HTMLElement>(".textLayer")!;
}
const lines = () =>
  Array.from(host.querySelectorAll<HTMLElement>("span[data-ocr-line]"));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Each glyph advances half the font size.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) => ({ width: text.length * 50 }),
  } as unknown as CanvasRenderingContext2D);
  host = document.createElement("div");
  document.body.append(host);
  selection = vi.fn();
  adapter = new PDFReaderAdapter(host, { location: vi.fn(), selection });
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fits each recognized line to its own box after the native text", () => {
  adapter.setBlocks([scan()]);
  const layer = renderTextLayer();
  expect(
    Array.from(layer.children).map(
      (child) => child.textContent || child.tagName,
    ),
  ).toEqual([
    "Native header",
    "BR",
    "Scanned line one",
    "BR",
    "Scanned line two",
    "BR",
    "DIV",
  ]);
  const [first, second] = lines();
  expect(parseFloat(first.style.left)).toBeCloseTo(10);
  expect(parseFloat(first.style.top)).toBeCloseTo(10);
  // 0.025 of 800 pt; 0.5 of 600 pt over 16 glyphs at 10 pt each.
  expect(first.style.getPropertyValue("--font-height")).toBe("20px");
  expect(Number(first.style.getPropertyValue("--scale-x"))).toBeCloseTo(
    300 / 160,
  );
  expect(parseFloat(second.style.top)).toBeCloseTo(14);
  expect(Number(second.style.getPropertyValue("--scale-x"))).toBeCloseTo(
    360 / 160,
  );
});

it("stores a dragged substring of a scan line at that line's box and highlights it", async () => {
  adapter.setBlocks([scan()]);
  renderTextLayer();
  const line = lines()[1];
  // Line two: x 0.1, y 0.14, width 0.6, height 0.025 of a 600 x 800 page at (20, 40).
  vi.spyOn(line, "getBoundingClientRect").mockReturnValue(
    new DOMRect(80, 152, 360, 20),
  );
  const range = document.createRange();
  range.setStart(line.firstChild!, 8);
  range.setEnd(line.firstChild!, 12);
  // The browser's fallback-font content area is taller than the line box.
  Object.assign(range, { getClientRects: () => [new DOMRect(260, 148, 90, 28)] });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const selected = adapter.getSelection();
  expect(selected?.text).toBe("line");
  const rects = selected?.location.type === "pdf" && selected.location.rects;
  expect(rects).toEqual([
    { x: 240 / 600, y: 112 / 800, width: 90 / 600, height: 20 / 800 },
  ]);
  const annotation: Annotation = {
    id: "mark",
    kind: "highlight",
    documentId: "scan",
    quote: "line",
    note: "",
    color: "#e6b94c",
    createdAt: "",
    location: selected!.location,
  };
  await adapter.highlight([annotation]);
  const mark = host.querySelector<HTMLElement>(".neoread-highlight")!;
  expect(parseFloat(mark.style.left)).toBeCloseTo(40);
  expect(parseFloat(mark.style.top)).toBeCloseTo(14);
  expect(parseFloat(mark.style.width)).toBeCloseTo(15);
});

it("keeps one copy of the lines across repaints, recycled layers and late blocks", () => {
  renderTextLayer();
  expect(lines()).toHaveLength(0);
  // Blocks parsed after the page rendered.
  adapter.setBlocks([scan()]);
  expect(lines()).toHaveLength(2);
  const painted = lines();
  // Zoom re-renders the same layer; CSS variables already follow the scale.
  // A refetch of the same parse must keep the spans a live selection uses.
  viewer.bus!.dispatch("textlayerrendered", { pageNumber: 1 });
  adapter.setBlocks([scan()]);
  expect(lines()).toEqual(painted);
  expect(lines()[0]).toBe(painted[0]);
  // Another page's render leaves this page alone.
  viewer.bus!.dispatch("textlayerrendered", { pageNumber: 2 });
  expect(lines()[0]).toBe(painted[0]);
  // PDF.js clears a recycled page and renders its text layer again.
  const layer = host.querySelector<HTMLElement>(".textLayer")!;
  layer.replaceChildren();
  adapter.setBlocks([scan(["Not rendered yet"])]);
  expect(lines()).toHaveLength(0);
  layer.innerHTML = '<div class="endOfContent"></div>';
  viewer.bus!.dispatch("textlayerrendered", { pageNumber: 1 });
  expect(lines().map((line) => line.textContent)).toEqual(["Not rendered yet"]);
  // A reparse that drops OCR lines removes them.
  adapter.setBlocks([{ ...scan(), ocrLines: undefined }]);
  expect(host.querySelectorAll("[data-ocr-line]")).toHaveLength(0);
});

it("turns lines back upright on a rotated page", () => {
  adapter.setBlocks([scan()]);
  renderTextLayer(90);
  const [first] = lines();
  // Display (x 0.1, y 0.1) is the unrotated layer's (0.1, 0.9).
  expect(parseFloat(first.style.left)).toBeCloseTo(10);
  expect(parseFloat(first.style.top)).toBeCloseTo(90);
  expect(first.style.getPropertyValue("--rotate")).toBe("-90deg");
  // The displayed page is 800 pt wide and 600 pt high.
  expect(first.style.getPropertyValue("--font-height")).toBe("15px");
  expect(Number(first.style.getPropertyValue("--scale-x"))).toBeCloseTo(
    400 / 120,
  );
});
