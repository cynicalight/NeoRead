import { expect, it, vi } from "vitest";
import { translationBlockAt } from "./translation-viewport";

it("finds the reading block in a long article with logarithmic geometry reads", () => {
  const measure = vi.fn((index: number) => ({ bottom: (index + 1) * 100 }));
  const nodes = Array.from(
    { length: 4096 },
    (_, index) =>
      ({ getBoundingClientRect: () => measure(index) }) as HTMLElement,
  );
  expect(translationBlockAt(nodes, 300_050)).toBe(nodes[3000]);
  expect(measure.mock.calls.length).toBeLessThanOrEqual(13);
  expect(translationBlockAt(nodes, -100)).toBe(nodes[0]);
  expect(translationBlockAt(nodes, 409_600)).toBeUndefined();
  expect(translationBlockAt([], 0)).toBeUndefined();
});
