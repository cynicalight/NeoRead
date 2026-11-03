import { afterEach, expect, it, vi } from "vitest";
import { blockImageCache } from "./block-images";

afterEach(() => vi.unstubAllGlobals());

it("reuses a block render unless a wider one is needed", async () => {
  let next = 0;
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++next}`,
    revokeObjectURL: revoke,
  });
  const render = vi.fn(async () => new Blob());
  const cache = blockImageCache(render);
  expect(await cache.url("p1-b1", 600)).toBe("blob:1");
  expect(await cache.url("p1-b1", 700)).toBe("blob:1");
  expect(render).toHaveBeenCalledWith("p1-b1", expect.any(AbortSignal), 768);
  expect(await cache.url("p1-b1", 1200)).toBe("blob:2");
  cache.dispose();
  expect(revoke).toHaveBeenCalledWith("blob:1");
  expect(revoke).toHaveBeenCalledWith("blob:2");
});

it("retries a block whose render failed", async () => {
  const render = vi
    .fn()
    .mockRejectedValueOnce(new Error("busy"))
    .mockResolvedValue(new Blob());
  vi.stubGlobal("URL", { createObjectURL: () => "blob:ok" });
  const cache = blockImageCache(render);
  await expect(cache.url("p1-b1", 600)).rejects.toThrow("busy");
  expect(await cache.url("p1-b1", 600)).toBe("blob:ok");
});

it("limits concurrent full PDF renders and never starts queued work after disposal", async () => {
  const finish: (() => void)[] = [];
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:ok",
    revokeObjectURL: vi.fn(),
  });
  const render = vi.fn(
    (_id: string, signal: AbortSignal) =>
      new Promise<Blob>((resolve, reject) => {
        finish.push(() => resolve(new Blob()));
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const cache = blockImageCache(render);
  const requests = Array.from({ length: 12 }, (_, i) =>
    cache.url(`p1-b${i}`, 2048),
  );
  const settled = Promise.allSettled(requests);
  expect(render).toHaveBeenCalledTimes(2);
  finish[0]();
  await requests[0];
  await Promise.resolve();
  expect(render).toHaveBeenCalledTimes(3);
  cache.dispose();
  await settled;
  expect(render).toHaveBeenCalledTimes(3);
});
