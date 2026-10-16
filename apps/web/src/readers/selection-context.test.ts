// @vitest-environment jsdom
import { expect, it } from "vitest";
import { nearbyWords, selectionContext } from "./selection-context";

it("captures context at the exact occurrence across DOM nodes", () => {
  const root = document.createElement("div");
  root.innerHTML =
    "<p>first repeated phrase</p><p>near <b>repeated</b> after</p>";
  const range = document.createRange();
  range.selectNodeContents(root.querySelector("b")!);
  expect(selectionContext(range, root)).toEqual({
    before: "first repeated phrase near",
    after: "after",
  });
});
it("keeps only the nearest 30 words on each side", () => {
  const words = Array.from({ length: 80 }, (_, n) => `word${n}`);
  expect(nearbyWords(words.join(" "), true)).toBe(words.slice(-30).join(" "));
  expect(nearbyWords(words.join(" "), false)).toBe(
    words.slice(0, 30).join(" "),
  );
  expect(nearbyWords("中".repeat(80), false)).toBe("中".repeat(30));
  expect(nearbyWords("!".repeat(9000), true)).toHaveLength(4000);
});
