// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@reader/core";

const state = vi.hoisted(() => ({
  scale: 1,
  scaleValue: "page-width",
  update: vi.fn(),
  pageNode: undefined as HTMLDivElement | undefined,
  resize: undefined as (() => void) | undefined,
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 10 }),
    destroy: vi.fn(),
  }),
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, () => void>();
    on(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
    off(name: string) {
      this.listeners.delete(name);
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    constructor(
      private options: { eventBus: { listeners: Map<string, () => void> } },
    ) {}
    setDocument(doc: unknown) {
      if (doc) this.options.eventBus.listeners.get("pagesinit")?.();
    }
    currentPageNumber = 1;
    getPageView() {
      return state.pageNode ? { div: state.pageNode } : undefined;
    }
    get currentScale() {
      return state.scale;
    }
    set currentScaleValue(value: string) {
      state.scaleValue = value;
      state.scale = value === "page-width" ? 1 : Number(value);
    }
    updateScale(options: { scaleFactor: number }) {
      state.update(options);
      state.scale = Math.round(state.scale * options.scaleFactor * 100) / 100;
      state.scaleValue = String(state.scale);
    }
  },
}));
import { PDFReaderAdapter } from "./pdf";

let adapter: PDFReaderAdapter;
let host: HTMLDivElement;
const zoom = vi.fn();
function key(key: string, target: EventTarget = document, extra = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  target.dispatchEvent(event);
  return event;
}
function wheel(extra: WheelEventInit = {}, target: EventTarget = host) {
  const event = new WheelEvent("wheel", {
    ctrlKey: true,
    deltaY: -20,
    clientX: 240,
    clientY: 320,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  target.dispatchEvent(event);
  return event;
}
beforeEach(async () => {
  vi.clearAllMocks();
  state.scale = 1;
  state.pageNode = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        state.resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  adapter = new PDFReaderAdapter(host, {
    location: vi.fn(),
    selection: vi.fn(),
    ...{ zoom },
  });
  await adapter.open({ id: "zoom-fixture", type: "pdf" } as Document);
  await adapter.setTheme(defaultTheme);
});
afterEach(async () => {
  await adapter.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it.each(["+", "="])(
  "zooms the PDF with Cmd %s and consumes the browser shortcut",
  (value) => {
    expect(key(value).defaultPrevented).toBe(true);
    expect(state.scale).toBeGreaterThan(1);
    expect(zoom).toHaveBeenLastCalledWith(state.scale);
  },
);
it("supports zoom out, Ctrl shortcuts and reset to fit width", () => {
  expect(
    key("-", document, { metaKey: false, ctrlKey: true }).defaultPrevented,
  ).toBe(true);
  expect(state.scale).toBeLessThan(1);
  expect(key("0").defaultPrevented).toBe(true);
  expect(state.scaleValue).toBe("page-width");
  expect(zoom).toHaveBeenLastCalledWith("width");
});
it.each([
  { ctrlKey: true, metaKey: false },
  { ctrlKey: false, metaKey: true },
])(
  "routes modified wheel input %j to PDF.js with the pointer as the zoom origin",
  (modifiers) => {
    expect(wheel(modifiers).defaultPrevented).toBe(true);
    expect(state.scale).toBeGreaterThan(1);
    expect(state.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        origin: [240, 320],
        drawingDelay: expect.any(Number),
      }),
    );
    expect(wheel({ ...modifiers, deltaY: 40 }).defaultPrevented).toBe(true);
    expect(state.scale).toBeLessThan(1);
  },
);
it("leaves ordinary scrolling and gestures outside the PDF untouched", () => {
  expect(wheel({ ctrlKey: false }).defaultPrevented).toBe(false);
  expect(wheel({}, document.body).defaultPrevented).toBe(false);
  expect(
    wheel({ ctrlKey: false, metaKey: true }, document.body).defaultPrevented,
  ).toBe(false);
  expect(state.update).not.toHaveBeenCalled();
});
it("accumulates small pinch deltas and handles line-based wheel input", () => {
  for (let i = 0; i < 100; i++) wheel({ deltaY: -0.1 });
  expect(state.scale).toBeGreaterThan(1);
  const previous = state.scale;
  wheel({ deltaY: -1, deltaMode: 1 });
  expect(state.scale).toBeGreaterThan(previous);
});
it.each([100, 120, 100000])(
  "limits a large wheel delta %s to a gentle step and reverses without drift",
  (delta) => {
    for (let i = 0; i < 10; i++) {
      wheel({ deltaY: -delta });
      expect(state.scale).toBeCloseTo(1.2, 2);
      wheel({ deltaY: delta });
      expect(state.scale).toBeCloseTo(1, 2);
    }
    wheel({ deltaY: delta });
    expect(state.scale).toBeCloseTo(1 / 1.2, 2);
  },
);
it("keeps small deltas proportional instead of applying a full wheel step", () => {
  wheel({ deltaY: -20 });
  expect(state.scale).toBeCloseTo(1.04, 2);
  wheel({ deltaY: 20 });
  expect(state.scale).toBeCloseTo(1, 2);
});
it.each([false, true])(
  "zooms from the visible scale after block focus (interrupted: %s)",
  async (interrupt) => {
    vi.useFakeTimers();
    try {
      Object.defineProperties(host, {
        clientWidth: { value: 600 },
        clientHeight: { value: 600 },
      });
      state.pageNode = document.createElement("div");
      state.pageNode.getBoundingClientRect = () =>
        new DOMRect(0, 0, 1000 * state.scale, 1200 * state.scale);
      adapter.setBlocks([
        {
          id: "focus-target",
          page: 1,
          label: "text",
          text: "Target",
          bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
        },
      ]);
      wheel({ deltaY: 100 });
      expect(state.scale).toBeCloseTo(0.83, 2);
      const pending = adapter.focusBlock("focus-target", "source");
      await vi.advanceTimersByTimeAsync(interrupt ? 96 : 500);
      const focused = state.scale;
      expect(focused).toBeGreaterThan(1);
      wheel({ deltaY: 100 });
      expect(state.scale).toBeCloseTo(focused / 1.2, 2);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(state.scale).toBeCloseTo(focused / 1.2, 2);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("ignores plain keys, composing input and alternate modifier chords", () => {
  expect(key("+", document, { metaKey: false }).defaultPrevented).toBe(false);
  expect(key("+", document, { altKey: true }).defaultPrevented).toBe(false);
  expect(key("+", document, { isComposing: true }).defaultPrevented).toBe(
    false,
  );
  expect(state.update).not.toHaveBeenCalled();
});
it("does not zoom while typing or interacting with a modal", () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  expect(key("+", input).defaultPrevented).toBe(false);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  expect(key("+", dialog).defaultPrevented).toBe(false);
  expect(state.update).not.toHaveBeenCalled();
});
it("keeps manual zoom across theme changes and resizing, then permits fit width", async () => {
  key("+");
  const manualScale = state.scale;
  expect(manualScale).toBeGreaterThan(1);
  await adapter.setTheme({ ...defaultTheme, mode: "dark", zoom: manualScale });
  state.resize?.();
  expect(state.scale).toBe(manualScale);
  await adapter.setTheme({ ...defaultTheme, zoom: "width" });
  expect(state.scaleValue).toBe("page-width");
});
it("bounds gesture zoom and removes event handlers on disposal", async () => {
  for (let i = 0; i < 40; i++) wheel({ deltaY: -100000 });
  expect(state.scale).toBe(5);
  for (let i = 0; i < 40; i++) wheel({ deltaY: 100000 });
  expect(state.scale).toBe(0.25);
  await adapter.destroy();
  state.update.mockClear();
  expect(key("+").defaultPrevented).toBe(false);
  expect(wheel().defaultPrevented).toBe(false);
  expect(state.update).not.toHaveBeenCalled();
});

it("resizes a manually zoomed PDF with its pane and preserves horizontal and vertical content position", async () => {
  let width = 800;
  Object.defineProperties(host, {
    clientWidth: { get: () => width, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
  host.getBoundingClientRect = () => new DOMRect(30, 50, width, 600);
  const page = document.createElement("div");
  page.className = "page";
  host.append(page);
  page.getBoundingClientRect = () =>
    new DOMRect(
      30 - host.scrollLeft,
      50 - host.scrollTop,
      1000 * state.scale,
      1200 * state.scale,
    );
  state.pageNode = page;
  await adapter.setTheme({ ...defaultTheme, zoom: 1.6 });
  host.scrollLeft = 320;
  host.scrollTop = 1100;
  vi.useFakeTimers();
  try {
    host.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(32);
    width = 400;
    state.resize?.();
    await vi.advanceTimersByTimeAsync(32);
    expect(state.scale).toBe(0.8);
    expect(host.scrollLeft).toBeCloseTo(160);
    expect(host.scrollTop).toBeCloseTo(400);
    expect(zoom).toHaveBeenLastCalledWith(0.8, "layout", 0.5);
    await adapter.setTheme({ ...defaultTheme, zoom: 0.8 });
    width = 800;
    state.resize?.();
    await vi.advanceTimersByTimeAsync(32);
    expect(state.scale).toBe(1.6);
    expect(host.scrollLeft).toBeCloseTo(320);
    expect(host.scrollTop).toBeCloseTo(1100);
  } finally {
    vi.useRealTimers();
  }
});
