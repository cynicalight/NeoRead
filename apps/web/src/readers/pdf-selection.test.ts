// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 1 }),
    destroy: async () => {},
  }),
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, Set<() => void>>();
    on(name: string, callback: () => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(callback);
    }
    off(name: string, callback: () => void) {
      this.listeners.get(name)?.delete(callback);
    }
    dispatch(name: string) {
      this.listeners.get(name)?.forEach((callback) => callback());
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    viewer: HTMLElement;
    eventBus: { dispatch(name: string): void };
    constructor(options: {
      viewer: HTMLElement;
      eventBus: { dispatch(name: string): void };
    }) {
      this.viewer = options.viewer;
      this.eventBus = options.eventBus;
      // PDFViewer._resetView clears lang both during construction and reload.
      this.viewer.removeAttribute("lang");
    }
    setDocument(pdf: unknown) {
      this.viewer.removeAttribute("lang");
      if (pdf) queueMicrotask(() => this.eventBus.dispatch("pagesinit"));
    }
  },
}));
import { PDFReaderAdapter } from "./pdf";
import { paper } from "../papers/fixtures";
let adapter: PDFReaderAdapter;
let host: HTMLDivElement;
let changed: Mock<
  (selection: import("@neoread/core").ReaderSelection | null) => void
>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  changed = vi.fn();
  adapter = new PDFReaderAdapter(host, {
    location: vi.fn(),
    selection: changed,
  });
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"><span>Selected passage</span></div>';
  const page = host.querySelector(".page")!;
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 40, 600, 800),
  );
  const range = document.createRange();
  range.selectNodeContents(page.firstChild!);
  Object.assign(range, {
    getClientRects: () => [new DOMRect(60, 100, 180, 20)],
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  page.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, clientX: 240, clientY: 115 }),
  );
  expect(adapter.getSelection()?.text).toBe("Selected passage");
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});
it("clears the displayed selection after clicking blank PDF space", () => {
  window.getSelection()!.removeAllRanges();
  host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(adapter.getSelection()).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});
it("keeps unknown PDF language independent of the app language after viewer resets", async () => {
  const previousLanguage = document.documentElement.lang;
  document.documentElement.lang = "zh-CN";
  try {
    await adapter.open(paper());
    expect(
      host.querySelector(".pdfViewer")!.closest("[lang]")?.getAttribute("lang"),
    ).toBe("");
  } finally {
    document.documentElement.lang = previousLanguage;
  }
});
it("clears the displayed selection when the browser collapses it without a mouseup", () => {
  window.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  expect(adapter.getSelection()).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("clears native ranges on explicit dismissal so the next mouseup cannot restore the toolbar", () => {
  adapter.clearSelection();
  expect(window.getSelection()!.rangeCount).toBe(0);
  host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(adapter.getSelection()).toBeNull();
});
it("records the release point near the selected line rather than the reader bottom", () => {
  expect(adapter.getSelection()?.anchor).toEqual({
    x: 240,
    top: 100,
    bottom: 120,
  });
});
it("preserves the selection for toolbar actions but clears it when clicking another panel", () => {
  const toolbar = document.createElement("div");
  toolbar.className = "selection-bar";
  document.body.append(toolbar);
  toolbar.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(adapter.getSelection()?.text).toBe("Selected passage");
  document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(adapter.getSelection()).toBeNull();
  expect(window.getSelection()!.rangeCount).toBe(0);
  toolbar.remove();
});
it("stores highlight rects at the text-layer span's em box, not the taller font content area", () => {
  const page = host.querySelector(".page")!;
  page.innerHTML = '<div class="textLayer"><span>Selected passage</span></div>';
  const span = page.querySelector(".textLayer span")!;
  // PDF.js sizes the span to the 20px em box; the fallback font's text rect is 1.4 em.
  vi.spyOn(span, "getBoundingClientRect").mockReturnValue(
    new DOMRect(60, 100, 180, 20),
  );
  const range = document.createRange();
  range.selectNodeContents(span.firstChild!);
  Object.assign(range, {
    getClientRects: () => [new DOMRect(60, 96, 180, 28)],
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  page.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const location = adapter.getSelection()?.location;
  expect(location?.type === "pdf" && location.rects).toEqual([
    { x: 40 / 600, y: 60 / 800, width: 180 / 600, height: 20 / 800 },
  ]);
});
