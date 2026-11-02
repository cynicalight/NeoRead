// @vitest-environment jsdom
import { useReaderStore } from "../store";
import { afterEach, expect, it, vi } from "vitest";
import { EPUBTransition } from "./epub-transition";

afterEach(() => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  vi.unstubAllGlobals();
});
const surface = () => {
  const element = document.createElement("div");
  const animate = vi.fn((_frames: Keyframe[], _options?: unknown) => ({
    finished: Promise.resolve(),
    cancel: vi.fn(),
  }));
  element.animate = animate as unknown as typeof element.animate;
  return { element, animate };
};

it("changes content only after the surface has faded out", async () => {
  const { element, animate } = surface();
  const transition = new EPUBTransition(element);
  const change = vi.fn(async () => {
    expect(animate).toHaveBeenCalledTimes(1);
    expect(transition.running).toBe(true);
    return "done";
  });
  await expect(transition.run(1, "x", change)).resolves.toBe("done");
  expect(animate).toHaveBeenCalledTimes(2);
  expect(transition.running).toBe(false);
});

it("reuses the outer fade when a page turn crosses into another chapter", async () => {
  const { element, animate } = surface();
  const transition = new EPUBTransition(element);
  await transition.run(1, "x", () => transition.run(1, "x", async () => {}));
  expect(animate).toHaveBeenCalledTimes(2);
});

it("fades without movement under reduced motion and still fades in after errors", async () => {
  useReaderStore.getState().setTheme({ reducedMotion: true });
  const { element, animate } = surface();
  const transition = new EPUBTransition(element);
  await expect(
    transition.run(1, "y", async () => {
      throw new Error("load failed");
    }),
  ).rejects.toThrow("load failed");
  expect(animate).toHaveBeenCalledTimes(2);
  for (const [frames] of animate.mock.calls)
    for (const frame of frames)
      expect(String(frame.transform)).not.toMatch(/[1-9]\d*px/);
  expect(transition.running).toBe(false);
});

it("runs the change directly where animations are unavailable", async () => {
  const element = document.createElement("div");
  Object.defineProperty(element, "animate", { value: undefined });
  const change = vi.fn(async () => {});
  await new EPUBTransition(element).run(1, "x", change);
  expect(change).toHaveBeenCalledOnce();
});
