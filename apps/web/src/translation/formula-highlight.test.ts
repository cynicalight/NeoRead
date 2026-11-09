// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearFormulaMarks,
  formulaAwareRects,
  formulaHighlightRules,
  markFormulas,
} from "./formula-highlight";

let host: HTMLParagraphElement, formula: HTMLElement;
const textOf = (text: string) =>
  [...host.querySelectorAll("*"), host]
    .flatMap((e) => [...e.childNodes])
    .find((n) => n.nodeType === Node.TEXT_NODE && n.textContent === text)!;
const runRange = (text: string) => {
  const range = document.createRange();
  range.selectNodeContents(textOf(text));
  return range;
};
beforeEach(() => {
  host = document.createElement("p");
  host.innerHTML =
    'maps <span class="katex"><span>x</span><span>1</span></span> to a sequence';
  document.body.append(host);
  formula = host.querySelector(".katex")!;
  // Text runs report a narrow rect; the formula reports its whole box.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      const text = this.startContainer.textContent ?? "";
      return [new DOMRect(text.length, 10, 5, 8)];
    },
  });
  formula.getClientRects = () =>
    [new DOMRect(100, 0, 40, 24)] as unknown as DOMRectList;
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

it("paints a formula as one box, once across its text runs", () => {
  const rects = formulaAwareRects([runRange("x"), runRange("1")]);
  expect(rects.map((r) => [r.x, r.width, r.height])).toEqual([[100, 40, 24]]);
});

it("keeps text outside formulas while replacing the formula runs", () => {
  const range = document.createRange();
  range.setStart(textOf("maps "), 2);
  range.setEnd(textOf(" to a sequence"), 3);
  const rects = formulaAwareRects([range]);
  expect(rects.map((r) => r.x)).toEqual(
    expect.arrayContaining([100, "maps ".length, " to a sequence".length]),
  );
  expect(rects.filter((r) => r.x === 100)).toHaveLength(1);
});

it("marks a touched formula whole and clears it with its highlight", () => {
  const range = document.createRange();
  range.setStart(textOf("maps "), 1);
  range.setEnd(textOf("x"), 1);
  markFormulas(host, "selection", [range]);
  markFormulas(host, "neoread-sentences-a-highlight-ffcc00", [runRange("1")]);
  expect(formula.dataset.formulaHighlight?.split(" ").sort()).toEqual([
    "neoread-sentences-a-highlight-ffcc00",
    "selection",
  ]);
  markFormulas(host, "selection", []);
  expect(formula.dataset.formulaHighlight).toBe(
    "neoread-sentences-a-highlight-ffcc00",
  );
  clearFormulaMarks(host, "neoread-sentences-a");
  expect(formula.hasAttribute("data-formula-highlight")).toBe(false);
});

it("leaves formulas outside the range unmarked", () => {
  markFormulas(host, "selection", [runRange(" to a sequence")]);
  expect(formula.hasAttribute("data-formula-highlight")).toBe(false);
});

it("moves highlight paint from formula runs to the formula box", () => {
  expect(formulaHighlightRules("mark", { background: "#ffcc0066" })).toEqual([
    '.katex[data-formula-highlight~="mark"] { background-color: #ffcc0066; border-radius: 2px; }',
    ".katex ::highlight(mark) { background-color: transparent; text-decoration: none; }",
  ]);
  expect(formulaHighlightRules("line", { underline: "#123456" })[0]).toBe(
    '.katex[data-formula-highlight~="line"] { box-shadow: inset 0 -2px #123456; }',
  );
});
