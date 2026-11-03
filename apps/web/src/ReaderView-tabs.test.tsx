// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document, type ReaderEvents } from "@neoread/core";
import { ReaderView } from "./ReaderView";
const fixture = vi.hoisted(() => ({
  events: new Map<string, ReaderEvents>(),
  destroyed: [] as string[],
  visible: new Map<string, boolean>(),
  toc: new Map<string, Promise<[]>>(),
}));
vi.mock("./readers/pdf", () => ({
  PDFReaderAdapter: class {
    id = "";
    constructor(
      _host: HTMLElement,
      private events: ReaderEvents,
    ) {}
    async open(doc: Document) {
      this.id = doc.id;
      fixture.events.set(doc.id, this.events);
      this.events.location({ type: "pdf", page: 1 }, 0.1);
    }
    async setTheme() {}
    setVisible(value: boolean) {
      fixture.visible.set(this.id, value);
    }
    async highlight() {}
    async getTOC() {
      return fixture.toc.get(this.id) ?? [];
    }
    async destroy() {
      fixture.destroyed.push(this.id);
    }
  },
}));
let host: HTMLDivElement, root: Root;
const location = vi.fn(),
  zoom = vi.fn();
function readers(active: string, ids = ["a", "b"]) {
  return (
    <>
      {ids.map((id) => (
        <ReaderView
          key={id}
          document={{ id, type: "pdf" } as Document}
          active={active === id}
          theme={defaultTheme}
          annotations={[]}
          onReady={() => {}}
          events={{
            location: (next) => location(id, next),
            selection: () => {},
            zoom,
          }}
        />
      ))}
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fixture.events.clear();
  fixture.visible.clear();
  fixture.toc.clear();
  fixture.destroyed.length = 0;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("does not let hidden reader events change progress or zoom, and reuses its engine when activated", async () => {
  await act(async () => root.render(readers("a", ["a"])));
  await act(async () => {
    await vi.waitFor(() => expect(fixture.events.size).toBe(1));
  });
  await act(async () => root.render(readers("b")));
  await act(async () => {
    await vi.waitFor(() =>
      expect([...fixture.events.keys()], host.textContent ?? "").toEqual([
        "a",
        "b",
      ]),
    );
  });
  location.mockClear();
  expect(fixture.visible.get("a")).toBe(false);
  expect(fixture.visible.get("b")).toBe(true);
  fixture.events.get("a")!.zoom?.(2);
  fixture.events.get("a")!.zoom?.(2.5, "focus");
  fixture.events.get("a")!.zoom?.(1, "layout", 0.5);
  fixture.events.get("a")!.location({ type: "pdf", page: 6 }, 0.6);
  expect(zoom).not.toHaveBeenCalled();
  expect(location).not.toHaveBeenCalled();
  const previous = fixture.events.get("a");
  await act(async () => root.render(readers("a")));
  expect(fixture.visible.get("a")).toBe(true);
  expect(fixture.visible.get("b")).toBe(false);
  fixture.events.get("a")!.location({ type: "pdf", page: 7 }, 0.7);
  fixture.events.get("a")!.zoom?.(1.5);
  expect(location).toHaveBeenLastCalledWith("a", { type: "pdf", page: 7 });
  expect(zoom).toHaveBeenLastCalledWith(1.5);
  fixture.events.get("a")!.zoom?.(2.5, "focus");
  expect(zoom).toHaveBeenLastCalledWith(2.5, "focus");
  fixture.events.get("a")!.zoom?.(1.25, "layout", 0.5);
  expect(zoom).toHaveBeenLastCalledWith(1.25, "layout", 0.5);
  expect(fixture.events.get("a")).toBe(previous);
  expect(fixture.destroyed).toEqual([]);
});

it("restores rendering when a hidden reader is activated while its TOC is loading", async () => {
  let finish!: (items: []) => void;
  fixture.toc.set("a", new Promise<[]>((resolve) => (finish = resolve)));
  await act(async () => root.render(readers("b", ["a"])));
  await act(async () => {
    await vi.waitFor(() => expect(fixture.visible.get("a")).toBe(false));
  });
  await act(async () => root.render(readers("a", ["a"])));
  expect(fixture.visible.get("a")).toBe(false);
  await act(async () => finish([]));
  expect(host.textContent).not.toContain("正在排版");
  expect(fixture.visible.get("a")).toBe(true);
  expect(fixture.destroyed).toEqual([]);
});
