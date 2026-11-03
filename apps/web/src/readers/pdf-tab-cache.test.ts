import { expect, it, vi } from "vitest";
import { PDFTabCache } from "./pdf-tab-cache";

it("keeps background readers within the canvas budget and evicts the oldest first", async () => {
  const cache = new PDFTabCache(256);
  const first = {},
    second = {},
    third = {};
  const a = vi.fn(),
    b = vi.fn(),
    c = vi.fn();
  cache.retain(first, 100, a);
  cache.retain(second, 100, b);
  await Promise.resolve();
  expect(a).not.toHaveBeenCalled();
  cache.retain(third, 100, c);
  await Promise.resolve();
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
  expect(c).not.toHaveBeenCalled();
});

it("waits for the incoming tab to leave the background budget before evicting", async () => {
  const cache = new PDFTabCache(256);
  const incoming = {},
    outgoing = {};
  const a = vi.fn(),
    b = vi.fn();
  cache.retain(incoming, 200, a);
  await Promise.resolve();
  cache.retain(outgoing, 200, b);
  cache.forget(incoming);
  await Promise.resolve();
  expect(a).not.toHaveBeenCalled();
  expect(b).not.toHaveBeenCalled();
});

it("accounts for late rendering and closed tabs without counting the same reader twice", async () => {
  const cache = new PDFTabCache(256);
  const first = {},
    second = {};
  const a = vi.fn(),
    b = vi.fn();
  cache.retain(first, 100, a);
  cache.retain(second, 100, b);
  cache.retain(second, 180, b);
  await Promise.resolve();
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
  cache.forget(second);
  cache.retain(first, 200, a);
  await Promise.resolve();
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
});
