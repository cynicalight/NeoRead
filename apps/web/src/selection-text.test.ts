// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import katex from "katex";
import { installFormulaClipboard, selectionText } from "./selection-text";
import { translatedSelection } from "./translation/selection";
import type { PDFBlock, TranslationBlock } from "@neoread/core";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
const math = (value: string) => katex.renderToString(value);
it("copies mixed text with single-dollar LaTeX rather than repeating KaTeX's hidden representations", () => {
  const host = document.createElement("p");
  host.innerHTML = `输出隐藏状态 ${math("H'")} 映射为大小为 ${math("v")} 的词表 ${math("X")} 上的词分布。`;
  document.body.append(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  expect(range.toString()).not.toBe(
    "输出隐藏状态 $H'$ 映射为大小为 $v$ 的词表 $X$ 上的词分布。",
  );
  expect(selectionText(range)).toBe(
    "输出隐藏状态 $H'$ 映射为大小为 $v$ 的词表 $X$ 上的词分布。",
  );
  const before = host.innerHTML;
  const remove = installFormulaClipboard();
  try {
    window.getSelection()!.addRange(range);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", selectionText(range));
    expect(host.innerHTML).toBe(before);
  } finally {
    remove();
  }
});
it("uses a complete formula when the selection starts inside its visual layer and leaves ordinary text alone", () => {
  const host = document.createElement("p");
  host.innerHTML = `普通文字 ${math("x_i^2")} 结束`;
  document.body.append(host);
  const node = host.querySelector(".katex-html .mord.mathnormal")!.firstChild!;
  const range = document.createRange();
  range.selectNodeContents(node);
  expect(selectionText(range)).toBe("$x_i^2$");
  range.setStart(host.firstChild!, 0);
  range.setEnd(host.firstChild!, 4);
  expect(selectionText(range)).toBe("普通文字");
});
it("uses the same normalized text for references while keeping existing annotation offsets in the rendered DOM", () => {
  const host = document.createElement("div");
  host.innerHTML = `<section data-translation-block="p1-b1"><span data-sentence="0">隐藏状态 ${math("H'")}</span></section>`;
  document.body.append(host);
  const range = document.createRange();
  range.selectNodeContents(host.querySelector("span[data-sentence]")!);
  range.getBoundingClientRect = () => new DOMRect(0, 0, 50, 20);
  const result = translatedSelection(
    host,
    range,
    [
      {
        id: "p1-b1",
        page: 1,
        text: "hidden state",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      } as PDFBlock,
    ],
    [
      {
        blockId: "p1-b1",
        sourceHash: "hash",
        status: "complete",
        sentences: [{ source: "hidden state", target: "隐藏状态 $H'$" }],
      } as TranslationBlock,
    ],
  );
  expect(result?.selection.text).toBe("隐藏状态 $H'$");
  expect(result?.selection.location.translation?.ranges?.[0].quote).toBe(
    range.toString(),
  );
});

it("omits equation numbers, formula actions and expanded originals from a bulk copy but allows an original to be copied separately", () => {
  const host = document.createElement("div");
  host.innerHTML = `<p>正文前</p><div class="translation-formula">${math("x=1")}<span class="translation-formula-number" data-copy-ignore>(3)</span><button data-copy-ignore>复制 LaTeX</button><details class="translation-formula-source" open><summary>查看原公式</summary><p>原图文字 ${math("x=1")}</p><button>复制原公式</button></details></div><p>正文后（见式 (3)）</p>`;
  document.body.append(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  expect(selectionText(range)).toBe("正文前$x=1$正文后（见式 (3)）");
  range.selectNodeContents(host.querySelector("details p")!);
  expect(selectionText(range)).toBe("原图文字 $x=1$");
  range.selectNodeContents(host.querySelector("button")!);
  expect(selectionText(range)).toBe("");
});
