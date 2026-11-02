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

it("revokes an offscreen figure URL and renders it again only when requested", async () => {
  const revoke = vi.fn();
  let index = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++index}`,
    revokeObjectURL: revoke,
  });
  const render = vi.fn(async () => new Blob());
  const cache = blockImageCache(render);
  expect(await cache.url("figure", 1200)).toBe("blob:1");
  cache.release("figure");
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledWith("blob:1");
  expect(await cache.url("figure", 1200)).toBe("blob:2");
  expect(render).toHaveBeenCalledTimes(2);
  cache.dispose();
});

it("keeps a shared figure until both the document and popup release it", async () => {
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:shared",
    revokeObjectURL: revoke,
  });
  const render = vi.fn(async () => new Blob());
  const cache = blockImageCache(render);
  const main = cache.url("figure", 1200, "document");
  expect(cache.url("figure", 1200, "popup")).toBe(main);
  await main;
  cache.release("figure", "document");
  await Promise.resolve();
  expect(revoke).not.toHaveBeenCalled();
  cache.release("figure", "popup");
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledOnce();
  cache.dispose();
});

it("cancels both in-flight zoom sizes when their figure leaves the viewport", async () => {
  const signals: AbortSignal[] = [];
  const render = vi.fn(
    (_id: string, signal: AbortSignal) =>
      new Promise<Blob>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const cache = blockImageCache(render);
  const small = cache.url("figure", 600),
    large = cache.url("figure", 2400);
  const done = Promise.allSettled([small, large]);
  cache.release("figure");
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect((await done).every((result) => result.status === "rejected")).toBe(
    true,
  );
  cache.dispose();
});
