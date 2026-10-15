// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@reader/core";
import { readFileSync } from "node:fs";

const styles = readFileSync("apps/web/src/style.css", "utf8");

const fixture = vi.hoisted(() => ({
  dispatch: undefined as ((name: string, event?: unknown) => void) | undefined,
  reset: vi.fn(),
  refresh: vi.fn(),
  viewerOptions: undefined as Record<string, unknown> | undefined,
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
    currentScale = 1;
    currentScaleValue = "page-width";
    constructor(options: Record<string, unknown>) {
      fixture.viewerOptions = options;
    }
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
let previewContexts: Map<
  HTMLCanvasElement,
  {
    drawImage: ReturnType<typeof vi.fn>;
    putImageData: ReturnType<typeof vi.fn>;
    getImageData: (
      x: number,
      y: number,
      width: number,
      height: number,
    ) => ImageData;
  }
>;
let worker: {
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

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
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        worker = this;
      }
    },
  );
  previewContexts = new Map();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      const element = this;
      let context = previewContexts.get(element);
      if (!context) {
        context = {
          drawImage: vi.fn(),
          putImageData: vi.fn(),
          getImageData: (_x, _y, width, height) =>
            new ImageData(
              new Uint8ClampedArray(width * height * 4).fill(255),
              width,
              height,
            ),
        };
        previewContexts.set(element, context);
      }
      return context as unknown as CanvasRenderingContext2D;
    },
  );
  stylesheet = document.createElement("style");
  const rule = styles.match(
    /\.pdf-container\[data-theme="dark"\][^{]+canvas:not\(\[data-pdf-dark-ready\]\)\s*\{[^}]+\}/,
  )?.[0];
  expect(rule).toBeTruthy();
  stylesheet.textContent = rule!;
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

function canvas() {
  const wrapper = document.createElement("div");
  wrapper.className = "canvasWrapper";
  const element = document.createElement("canvas");
  element.width = element.height = 1;
  wrapper.append(element);
  host.append(wrapper);
  const context = {
    getImageData: vi.fn(
      () =>
        new ImageData(
          new Uint8ClampedArray(element.width * element.height * 4).fill(255),
          element.width,
          element.height,
        ),
    ),
    putImageData: vi.fn(),
  };
  Object.defineProperty(element, "getContext", {
    configurable: true,
    value: vi.fn(() => context),
  });
  return { element, context };
}
function rendered(
  element: HTMLCanvasElement,
  isDetailView = false,
  pageNumber = 1,
) {
  fixture.dispatch!("pagerendered", {
    pageNumber,
    isDetailView,
    source: { canvas: element },
  });
}
function reply(id: number) {
  worker.onmessage!({
    data: { id, pixels: new Uint8ClampedArray([36, 36, 36, 255]).buffer },
  } as MessageEvent);
}

it("hides initial and detail canvases until dark pixels have been written", async () => {
  expect(fixture.viewerOptions).toMatchObject({
    maxCanvasPixels: 4 * 1024 * 1024,
    maxCanvasDim: 4096,
  });
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  expect(host.dataset.theme).toBe("dark");
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  for (const detail of [false, true]) {
    const { element, context } = canvas();
    expect(getComputedStyle(element).visibility).toBe("hidden");
    rendered(element, detail);
    expect(getComputedStyle(element).visibility).toBe("hidden");
    expect(context.putImageData).not.toHaveBeenCalled();
    expect(
      new Uint8ClampedArray(worker.postMessage.mock.lastCall![0].pixels),
    ).toEqual(new Uint8ClampedArray([255, 255, 255, 255]));
    const preview = host.querySelector<HTMLCanvasElement>(".pdf-dark-preview")!;
    expect(getComputedStyle(preview).visibility).toBe("visible");
    expect(
      previewContexts.get(preview)!.putImageData.mock.lastCall![0].data,
    ).toEqual(new Uint8ClampedArray([36, 36, 36, 255]));
    reply(worker.postMessage.mock.lastCall![0].id);
    expect(context.putImageData.mock.lastCall![0].data).toEqual(
      new Uint8ClampedArray([36, 36, 36, 255]),
    );
    expect(getComputedStyle(element).visibility).toBe("visible");
    expect(host.querySelector(".pdf-dark-preview")).toBeNull();
  }
});

it("does not reveal an obsolete result after the reading appearance changes", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  const { element, context } = canvas();
  rendered(element);
  const id = worker.postMessage.mock.lastCall![0].id;
  await adapter.setTheme({
    ...defaultTheme,
    mode: "dark",
    pdfDarkContrast: "high",
  });
  reply(id);
  expect(context.putImageData).not.toHaveBeenCalled();
  expect(getComputedStyle(element).visibility).toBe("hidden");
  expect(host.querySelector(".pdf-dark-preview")).toBeNull();
});

function position(element: HTMLElement, top: number, bottom: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
  } as DOMRect);
}

it("keeps queued pages visible and processes the latest visible page before skipped pages", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  position(host, 0, 100);
  const first = canvas();
  const skipped = canvas();
  const visible = canvas();
  position(first.element, -300, -200);
  position(skipped.element, -200, -100);
  position(visible.element, 0, 100);
  rendered(first.element, false, 1);
  rendered(skipped.element, false, 2);
  rendered(visible.element, false, 3);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(skipped.context.getImageData).not.toHaveBeenCalled();
  expect(visible.context.getImageData).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".pdf-dark-preview")).toHaveLength(3);
  host.dispatchEvent(new Event("scroll"));
  reply(worker.postMessage.mock.lastCall![0].id);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(visible.context.getImageData).toHaveBeenCalledTimes(1);
  expect(skipped.context.getImageData).not.toHaveBeenCalled();
  reply(worker.postMessage.mock.lastCall![0].id);
  expect(getComputedStyle(visible.element).visibility).toBe("visible");
  expect(skipped.context.getImageData).toHaveBeenCalledTimes(1);
  reply(worker.postMessage.mock.lastCall![0].id);
  expect(host.querySelector(".pdf-dark-preview")).toBeNull();
});

it("drops released canvases and continues after an obsolete in-flight page", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  const first = canvas();
  const released = canvas();
  const replacement = canvas();
  rendered(first.element);
  rendered(released.element);
  rendered(replacement.element);
  first.element.remove();
  released.element.remove();
  host.dispatchEvent(new Event("scroll"));
  expect(host.querySelectorAll(".pdf-dark-preview")).toHaveLength(1);
  reply(worker.postMessage.mock.lastCall![0].id);
  expect(first.context.putImageData).not.toHaveBeenCalled();
  expect(released.context.getImageData).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  reply(worker.postMessage.mock.lastCall![0].id);
  expect(getComputedStyle(replacement.element).visibility).toBe("visible");
});

it("bounds previews at high zoom and does not reprocess repeated detail notifications", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  const { element } = canvas();
  element.width = 2048;
  element.height = 1024;
  Object.assign(element.style, {
    left: "20%",
    top: "30%",
    width: "40%",
    height: "50%",
  });
  rendered(element, true);
  const preview = host.querySelector<HTMLCanvasElement>(".pdf-dark-preview")!;
  expect([preview.width, preview.height]).toEqual([512, 256]);
  expect(preview.style.cssText).toBe(element.style.cssText);
  expect(preview.dataset.pdfDarkDetail).toBe("true");
  rendered(element, true);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(host.querySelectorAll(".pdf-dark-preview")).toHaveLength(1);
});

it("cancels the old queue on a theme change without blocking the newly rendered page", async () => {
  adapter.preferTheme({ ...defaultTheme, mode: "dark" });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  rendered(canvas().element);
  rendered(canvas().element);
  const previousWorker = worker;
  const previousId = previousWorker.postMessage.mock.lastCall![0].id;
  await adapter.setTheme({
    ...defaultTheme,
    mode: "dark",
    pdfDarkContrast: "high",
  });
  expect(previousWorker.terminate).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".pdf-dark-preview")).toBeNull();
  const fresh = canvas();
  rendered(fresh.element);
  const preview = host.querySelector<HTMLCanvasElement>(".pdf-dark-preview")!;
  expect(
    previewContexts.get(preview)!.putImageData.mock.lastCall![0].data,
  ).toEqual(new Uint8ClampedArray([0, 0, 0, 255]));
  previousWorker.onmessage!({
    data: {
      id: previousId,
      pixels: new Uint8ClampedArray([36, 36, 36, 255]).buffer,
    },
  } as MessageEvent);
  previousWorker.onerror!();
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(fresh.context.putImageData).not.toHaveBeenCalled();
  reply(worker.postMessage.mock.lastCall![0].id);
  expect(getComputedStyle(fresh.element).visibility).toBe("visible");
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
});

it("rerenders and falls back to main-thread processing when the worker fails", async () => {
  adapter.preferTheme({
    ...defaultTheme,
    mode: "dark",
    pdfDarkContrast: "high",
  });
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  rendered(canvas().element);
  worker.onerror!();
  expect(worker.terminate).toHaveBeenCalled();
  expect(fixture.reset).toHaveBeenCalled();
  const { element, context } = canvas();
  rendered(element);
  expect(context.putImageData.mock.lastCall![0].data).toEqual(
    new Uint8ClampedArray([0, 0, 0, 255]),
  );
  expect(getComputedStyle(element).visibility).toBe("visible");
});

it("displays light canvases without waiting for dark processing", async () => {
  adapter.preferTheme(defaultTheme);
  await adapter.open({ id: "doc", type: "pdf" } as Document);
  const { element, context } = canvas();
  rendered(element);
  expect(getComputedStyle(element).visibility).toBe("visible");
  expect(context.putImageData).not.toHaveBeenCalled();
});
