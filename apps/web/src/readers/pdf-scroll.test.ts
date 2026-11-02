// @vitest-environment jsdom
import { useReaderStore } from "../store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { animatePDFScroll } from "./pdf-scroll";

let frames: FrameRequestCallback[];
beforeEach(() => {
  frames = [];
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  useReaderStore.getState().setTheme({ reducedMotion: false });
});
afterEach(() => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function tick(time: number) {
  const current = frames.splice(0);
  current.forEach((callback) => callback(time));
}
it("moves both axes through intermediate positions before settling", async () => {
  const host = document.createElement("div");
  const moved = vi.fn();
  const pending = animatePDFScroll(host, 500, 1000, () => false, moved);
  expect(host.scrollTop).toBe(0);
  tick(0);
  tick(120);
  expect(host.scrollTop).toBeGreaterThan(0);
  expect(host.scrollTop).toBeLessThan(1000);
  expect(host.scrollLeft).toBe(host.scrollTop / 2);
  tick(240);
  await pending;
  expect(host.scrollTop).toBe(1000);
  expect(host.scrollLeft).toBe(500);
  expect(frames).toHaveLength(0);
});
it("does not overwrite manual positioning after cancellation", async () => {
  const host = document.createElement("div");
  let cancelled = false;
  const pending = animatePDFScroll(
    host,
    500,
    1000,
    () => cancelled,
    () => {},
  );
  tick(0);
  tick(80);
  cancelled = true;
  host.scrollTop = 42;
  tick(160);
  await pending;
  expect(host.scrollTop).toBe(42);
  expect(frames).toHaveLength(0);
});
it("respects reduced motion and clamps destinations to scrollable bounds", async () => {
  useReaderStore.getState().setTheme({ reducedMotion: true });
  const host = document.createElement("div");
  Object.defineProperties(host, {
    scrollWidth: { value: 800 },
    clientWidth: { value: 600 },
    scrollHeight: { value: 2000 },
    clientHeight: { value: 600 },
  });
  await animatePDFScroll(
    host,
    1000,
    3000,
    () => false,
    () => {},
  );
  expect(host.scrollLeft).toBe(200);
  expect(host.scrollTop).toBe(1400);
  expect(frames).toHaveLength(0);
});
