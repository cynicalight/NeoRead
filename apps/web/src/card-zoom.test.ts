import { expect, it } from "vitest";
import { cardScales, nextCardScale } from "./useCardZoom";

it("steps card sizes within the limits and snaps saved values between steps", () => {
  expect(nextCardScale(1, 1)).toBe(1.15);
  expect(nextCardScale(1, -1)).toBe(0.9);
  expect(nextCardScale(cardScales[0], -1)).toBe(cardScales[0]);
  expect(nextCardScale(cardScales.at(-1)!, 1)).toBe(cardScales.at(-1));
  expect(nextCardScale(1.05, 1)).toBe(1.15);
  expect(nextCardScale(1.05, -1)).toBe(1);
});
