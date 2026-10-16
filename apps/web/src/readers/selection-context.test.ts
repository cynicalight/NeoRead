// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
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

it("stops at nearby words without reading distant chapter text or cloning DOM", () => {
  const root = document.createElement("div");
  root.innerHTML = `<p>unread before</p><p>${"before ".repeat(100)}<b>selected</b>${" after".repeat(100)}</p><p>unread after</p>`;
  for (const node of [
    root.firstChild!.firstChild!,
    root.lastChild!.firstChild!,
  ]) {
    Object.defineProperty(node, "data", {
      get() {
        throw new Error("read distant text");
      },
    });
  }
  const range = document.createRange();
  range.selectNodeContents(root.querySelector("b")!);
  const clone = vi
    .spyOn(Range.prototype, "cloneContents")
    .mockImplementation(() => {
      throw new Error("cloned chapter");
    });
  try {
    expect(selectionContext(range, root)).toEqual({
      before: Array(30).fill("before").join(" "),
      after: Array(30).fill("after").join(" "),
    });
    expect(clone).not.toHaveBeenCalled();
  } finally {
    clone.mockRestore();
  }
});

it("handles text and element offsets without leaving the root or breaking inline words", () => {
  const root = document.createElement("div");
  root.innerHTML = "<p>pre<b>fix</b> selected suf<i>fix</i></p>";
  const text = root.firstChild!.childNodes[2];
  const range = document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, 9);
  expect(selectionContext(range, root)).toEqual({
    before: "prefix",
    after: "suffix",
  });
  range.setStart(root.firstChild!, 2);
  range.setEnd(root.firstChild!, 3);
  expect(selectionContext(range, root)).toEqual({
    before: "prefix",
    after: "fix",
  });
});

it("bounds traversal even when thousands of nearby nodes contain no words", () => {
  const root = document.createElement("div");
  root.innerHTML =
    "<b>selected</b>" + "<span></span>".repeat(5000) + "<p>far away</p>";
  const range = document.createRange();
  range.selectNodeContents(root.firstChild!);
  const next = vi.spyOn(Node.prototype, "nextSibling", "get");
  try {
    expect(selectionContext(range, root)).toEqual({ before: "", after: "" });
    expect(next.mock.calls.length).toBeLessThanOrEqual(512);
  } finally {
    next.mockRestore();
  }
});
