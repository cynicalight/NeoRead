// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installTeXCopy, texText } from "./tex-text";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
const host = () => {
  document.body.innerHTML =
    '<p>maps <span class="markdown-math" data-tex="(x_1, ..., x_n)"><span class="katex">(x1,...,xn)(x_1, ..., x_n)</span></span> to <span class="markdown-math display" data-tex="a^2"><span class="katex">a2</span></span></p>';
  return document.querySelector("p")!;
};

it("writes touched formulas back as whole TeX", () => {
  const p = host();
  const range = document.createRange();
  range.setStart(p.firstChild!, 0);
  range.setEnd(p.querySelector(".katex")!.firstChild!, 2);
  expect(texText(range)).toBe("maps $(x_1, ..., x_n)$");
  range.selectNodeContents(p);
  expect(texText(range)).toBe("maps $(x_1, ..., x_n)$ to $$a^2$$");
});

it("copies a selection inside one formula as the whole formula", () => {
  const p = host();
  const glyphs = p.querySelector(".katex")!.firstChild!;
  const range = document.createRange();
  range.setStart(glyphs, 1);
  range.setEnd(glyphs, 2);
  expect(texText(range)).toBe("$(x_1, ..., x_n)$");
  range.selectNodeContents(p.querySelector(".markdown-math")!);
  expect(texText(range)).toBe("$(x_1, ..., x_n)$");
});

it("puts TeX on the clipboard only for selections with formulas", () => {
  const p = host();
  dispose = installTeXCopy(document);
  const copy = () => {
    const data = new Map<string, string>();
    const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { setData: (type: string, text: string) => data.set(type, text) },
    });
    document.dispatchEvent(event);
    return { text: data.get("text/plain"), prevented: event.defaultPrevented };
  };
  const selection = window.getSelection()!;
  selection.selectAllChildren(p);
  expect(copy()).toEqual({
    text: "maps $(x_1, ..., x_n)$ to $$a^2$$",
    prevented: true,
  });
  selection.setBaseAndExtent(p.firstChild!, 0, p.firstChild!, 4);
  expect(copy()).toEqual({ text: undefined, prevented: false });
});
