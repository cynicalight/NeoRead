// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranslationZoom } from "./useTranslationZoom";

let host: HTMLDivElement, root: Root;
let width: number;
let notify: () => void;
const rendered = vi.fn();
function Pane() {
  const pane = useRef<HTMLDivElement>(null);
  const zoom = useTranslationZoom(pane, true);
  rendered(zoom.width);
  return (
    <div ref={pane} data-pane>
      <div style={{ width: zoom.width }} />
    </div>
  );
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  width = 600;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Pane />));
  rendered.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("commits translation wrapping once after native window resizing settles", async () => {
  const body = host.querySelector<HTMLElement>("[data-pane] > div")!;
  expect(body.style.width).toBe("568px");
  for (const next of [700, 800, 1000]) {
    width = next;
    await act(async () => {
      notify();
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(body.style.width).toBe("568px");
  }
  expect(rendered).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(body.style.width).toBe("968px");
  expect(rendered).toHaveBeenCalledExactlyOnceWith(968);
});

it("cancels a pending width change when the pane closes", async () => {
  width = 1000;
  await act(async () => {
    notify();
  });
  await act(async () => root.render(null));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(rendered).not.toHaveBeenCalled();
});
