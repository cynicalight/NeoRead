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

it("keeps the line breaks the rendered text has", () => {
  // jsdom has no layout; stand in for innerText's block and <br> breaks.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return [...this.childNodes].map((n) => n.textContent).join("\n");
    },
  });
  try {
    document.body.innerHTML =
      '<div id="a"><p>one <span class="markdown-math" data-tex="x"><span class="katex">x</span></span></p><p>two</p></div>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("a")!);
    expect(texText(range)).toBe("one $x$\ntwo");
    expect(document.body.children).toHaveLength(1);
  } finally {
    delete (HTMLElement.prototype as { innerText?: string }).innerText;
  }
});

it("leaves out text the selection's container hides", () => {
  // jsdom has no layout; stand in for innerText skipping display:none.
  const shown = (node: Node): string =>
    node instanceof Element && getComputedStyle(node).display === "none"
      ? ""
      : node.nodeType === Node.TEXT_NODE
        ? node.textContent!
        : [...node.childNodes].map(shown).join("");
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return shown(this);
    },
  });
  try {
    document.body.innerHTML =
      '<style>.only [data-run] { display: none }</style><div class="only"><p><span data-run>source </span>one <span class="markdown-math" data-tex="x"><span class="katex">x</span></span></p><p><span data-run>hidden </span>two</p></div>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".only")!);
    expect(texText(range)).toBe("one $x$two");
    expect(document.querySelector(".only")!.children).toHaveLength(2);
  } finally {
    delete (HTMLElement.prototype as { innerText?: string }).innerText;
  }
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
