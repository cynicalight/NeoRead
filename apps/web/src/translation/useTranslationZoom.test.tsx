// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTranslationZoom } from "./useTranslationZoom";

it("zooms the whole translation around the pointer, clamps zoom and retains it across mode changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize!: ResizeObserverCallback;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let controls!: ReturnType<typeof useTranslationZoom>;
  function Fixture({ enabled }: { enabled: boolean }) {
    const pane = useRef<HTMLDivElement>(null);
    controls = useTranslationZoom(pane, enabled);
    return (
      <div ref={pane}>
        <div style={{ zoom: controls.zoom, width: controls.width }}>
          译文、公式与图片
        </div>
      </div>
    );
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Fixture enabled />));
    const pane = host.firstElementChild as HTMLDivElement;
    Object.defineProperty(pane, "clientWidth", {
      configurable: true,
      value: 832,
    });
    await act(async () => resize([], {} as ResizeObserver));
    expect(controls.width).toBe(800);
    pane.scrollTop = 100;
    pane.scrollLeft = 50;
    await act(async () =>
      pane.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -300 * Math.log(2),
          clientX: 20,
          clientY: 40,
          cancelable: true,
        }),
      ),
    );
    expect(controls.zoom).toBe(2);
    expect(pane.scrollTop).toBe(240);
    expect(pane.scrollLeft).toBe(120);
    await act(async () => controls.change(100));
    expect(controls.zoom).toBe(5);
    await act(async () => root.render(<Fixture enabled={false} />));
    await act(async () => root.render(<Fixture enabled />));
    expect(controls.zoom).toBe(5);
    await act(async () => controls.change(0));
    expect(controls.zoom).toBe(1);
    for (const modifier of ["ctrlKey", "metaKey"]) {
      for (const event of [
        new WheelEvent("wheel", {
          [modifier]: true,
          deltaY: 3000,
          cancelable: true,
        }),
        new KeyboardEvent("keydown", {
          [modifier]: true,
          key: "-",
          cancelable: true,
        }),
      ]) {
        const before = { top: pane.scrollTop, left: pane.scrollLeft };
        await act(async () => pane.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(controls.zoom).toBe(1);
        expect(pane.scrollTop).toBe(before.top);
        expect(pane.scrollLeft).toBe(before.left);
      }
    }
    // Both a wider window and a narrower split keep the fitted lower bound.
    for (const width of [1232, 432]) {
      Object.defineProperty(pane, "clientWidth", {
        configurable: true,
        value: width,
      });
      await act(async () => resize([], {} as ResizeObserver));
      expect(controls.zoom).toBe(1);
      expect(controls.width).toBe(width - 32);
      expect((pane.firstElementChild as HTMLElement).style.width).toBe(
        `${width - 32}px`,
      );
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
