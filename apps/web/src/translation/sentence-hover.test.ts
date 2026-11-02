// @vitest-environment jsdom
import { useReaderStore } from "../store";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SentenceHover } from "./sentence-hover";
let host: HTMLDivElement, hover: SentenceHover;
const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] =
  [];
const range = () => {
  const r = document.createRange();
  r.selectNodeContents(host.firstChild!);
  return r;
};
beforeEach(() => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  host = document.createElement("div");
  host.textContent = "sentence";
  document.body.append(host);
  host.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: vi.fn(() => [new DOMRect(10, 10, 120, 20)]),
  });
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => {
      let finish!: () => void;
      const cancel = vi.fn(),
        finished = new Promise<void>((r) => {
          finish = r;
        });
      animations.push({ finish, cancel });
      return { finished, cancel };
    }),
  });
  hover = new SentenceHover(host);
});
afterEach(() => {
  useReaderStore.getState().setTheme({ reducedMotion: false });
  hover.destroy();
  host.remove();
  animations.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).animate;
});
const layers = () => document.querySelectorAll(".neoread-sentence-hover-layer");
it("uses compositor opacity without ancestor style writes or JS animation frames", async () => {
  const writes = vi.spyOn(host.style, "setProperty");
  const frames = vi.spyOn(window, "requestAnimationFrame");
  hover.show("first", [range()]);
  expect(Element.prototype.animate).toHaveBeenCalledWith(
    [{ opacity: "0" }, { opacity: 1 }],
    expect.objectContaining({ duration: 160 }),
  );
  expect(layers()).toHaveLength(1);
  expect(layers()[0].parentElement).toBe(document.body);
  expect(writes).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
  animations[0].finish();
  await Promise.resolve();
  expect(layers()).toHaveLength(1);
  hover.clear();
  expect(layers()).toHaveLength(1);
  animations.at(-1)!.finish();
  await Promise.resolve();
  expect(layers()).toHaveLength(0);
});
it("reuses a stationary sentence without geometry reads and crossfades a new sentence", async () => {
  hover.show("first", [range()]);
  const reads = Range.prototype.getClientRects as ReturnType<typeof vi.fn>;
  reads.mockClear();
  for (let i = 0; i < 30; i++) hover.show("first", [range()]);
  expect(reads).not.toHaveBeenCalled();
  hover.show("second", [range()]);
  expect(layers()).toHaveLength(2);
  animations[1].finish();
  await Promise.resolve();
  expect(layers()).toHaveLength(1);
  hover.invalidate();
  hover.show("second", [range()]);
  expect(layers()).toHaveLength(1);
  hover.clear(true);
  expect(layers()).toHaveLength(0);
});
it("clips highlights to the visible reader, honors reduced motion, and cleans up", () => {
  useReaderStore.getState().setTheme({ reducedMotion: true });
  vi.mocked(Range.prototype.getClientRects).mockReturnValue([
    new DOMRect(280, 10, 100, 20),
  ] as unknown as DOMRectList);
  hover.show("first", [range()]);
  expect((layers()[0] as HTMLElement).style.width).toBe("20px");
  expect(Element.prototype.animate).not.toHaveBeenCalled();
  hover.destroy();
  expect(layers()).toHaveLength(0);
});
