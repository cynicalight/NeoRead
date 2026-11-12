import { expect, it } from "vitest";
import { categoryDrop } from "./model";

it("lifts a child to the root after a sibling and its descendants", () => {
  expect(
    categoryDrop(["A", "A/B", "A/B/C", "D", "D/E"], "A/B", "D", "after"),
  ).toEqual({
    path: "B",
    categories: ["A", "D", "D/E", "B", "B/C"],
  });
});
it("rejects cycles, collisions and overlong descendant paths", () => {
  expect(() => categoryDrop(["A", "A/B"], "A", "A/B", "inside")).toThrow();
  expect(() => categoryDrop(["A", "A/B", "B"], "B", "A", "inside")).toThrow();
  const long = "x".repeat(37);
  expect(() => categoryDrop(["A", "A/B", long], "A", long, "inside")).toThrow();
});
