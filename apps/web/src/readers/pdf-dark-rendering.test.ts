// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@reader/core";
import { readFileSync } from "node:fs";

const styles = readFileSync("apps/web/src/style.css", "utf8");

const fixture = vi.hoisted(() => ({
  dispatch: undefined as ((name: string, event?: unknown) => void) | undefined,
  reset: vi.fn(),
  refresh: vi.fn(),
  options: undefined as
    | { getReaderColorAdapter: (page: number) => { background: string } | null }
    | undefined,
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 1 }),
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
      this.listeners.get(name)?.forEach((callback) => callback(event));
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    constructor(options: NonNullable<typeof fixture.options>) {
      fixture.options = options;
    }
    currentScale = 1;
    currentScaleValue = "page-width";
    setDocument(doc: unknown) {
      if (doc) fixture.dispatch!("pagesinit");
    }
    getPageView() {
      return { reset: fixture.reset };
    }
    refresh = fixture.refresh;
  },
}));

import { PDFReaderAdapter } from "./pdf";
let host: HTMLDivElement;
let adapter: PDFReaderAdapter;
let stylesheet: HTMLStyleElement;
const pixelWorker = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("Worker", pixelWorker);
  stylesheet = document.createElement("style");
  stylesheet.textContent = (
    styles.match(/\.pdf-container[^{}]*\.canvasWrapper[^{}]*\{[^}]+\}/g) ?? []
  ).join("\n");
  document.head.append(stylesheet);
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
  stylesheet.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("provides dark source colors before rendering without creating a pixel worker", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  expect(fixture.options!.getReaderColorAdapter(1)?.background).toBe("#242424");
  expect(pixelWorker).not.toHaveBeenCalled();
});

it("creates fresh drawing adapters and cancels old page renders when appearance changes", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  const before = fixture.options!.getReaderColorAdapter(1)!;
  await adapter.setTheme({
    ...defaultTheme,
    mode: "dark",
    pdfDarkContrast: "high",
  });
  expect(fixture.reset).toHaveBeenCalled();
  expect(fixture.options!.getReaderColorAdapter(1)?.background).toBe("#000000");
  expect(before.background).toBe("#242424");
  await adapter.setTheme({ ...defaultTheme, mode: "light" });
  expect(fixture.options!.getReaderColorAdapter(1)).toBeNull();
});

it("contains detail canvases below text and keeps native selection above page pixels", () => {
  const wrapper = document.createElement("div");
  wrapper.className = "canvasWrapper";
  host.append(wrapper);
  const detail = document.createElement("canvas");
  detail.className = "detailView";
  const selection = document.createElement("div");
  selection.className = "selection";
  wrapper.append(detail, selection);
  expect(getComputedStyle(wrapper).isolation).toBe("isolate");
  expect(Number(getComputedStyle(selection).zIndex)).toBeGreaterThan(
    Number(getComputedStyle(detail).zIndex),
  );
});

it("brightens native PDF highlights on dark paper", () => {
  host.dataset.theme = "dark";
  const wrapper = document.createElement("div");
  wrapper.className = "canvasWrapper";
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  mark.classList.add("highlight");
  wrapper.append(mark);
  host.append(wrapper);
  expect(getComputedStyle(mark).getPropertyValue("--blend-mode")).toBe(
    "screen",
  );
});
