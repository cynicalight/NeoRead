// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTranslationSelectionHighlight } from "./selection-highlight";

let host: HTMLDivElement, registry: Map<string, Set<Range>>;
let dispose: (() => void) | undefined;
const update = () => document.dispatchEvent(new Event("selectionchange"));
const highlighted = () =>
  [...(registry.get("neoread-translation-selection") ?? [])].map((r) =>
    r.toString(),
  );
beforeEach(() => {
  registry = new Map();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  host = document.createElement("div");
  host.innerHTML =
    "<p>第一句<strong>重要内容</strong>。</p><p>第二句内容。</p>";
  document.body.append(host);
  dispose = installTranslationSelectionHighlight(host);
});
afterEach(() => {
  dispose?.();
  window.getSelection()?.removeAllRanges();
  host.remove();
  vi.unstubAllGlobals();
});

it("mirrors the exact partial selection across formatted paragraphs without changing native ranges or text", () => {
  const range = document.createRange();
  range.setStart(host.querySelector("strong")!.firstChild!, 1);
  range.setEnd(host.querySelectorAll("p")[1].firstChild!, 3);
  const selection = window.getSelection()!;
  selection.addRange(range);
  const html = host.innerHTML;
  update();
  expect(highlighted()).toEqual(["要内容。第二句"]);
  expect(selection.getRangeAt(0)).toBe(range);
  expect(selection.toString()).toBe("要内容。第二句");
  expect(host.innerHTML).toBe(html);
  expect(host.hasAttribute("data-compact-selection")).toBe(true);
});

it("tracks dragging and keyboard changes, then restores normal selection painting on clear or disposal", () => {
  const selection = window.getSelection()!,
    text = host.querySelector("strong")!.firstChild!;
  selection.setBaseAndExtent(text, 4, text, 1);
  update();
  expect(highlighted()).toEqual(["要内容"]);
  expect(selection.anchorOffset).toBe(4);
  expect(selection.focusOffset).toBe(1);
  selection.extend(text, 2);
  update();
  expect(highlighted()).toEqual(["内容"]);
  selection.collapseToStart();
  update();
  expect(registry.size).toBe(0);
  expect(host.hasAttribute("data-compact-selection")).toBe(false);
  selection.setBaseAndExtent(text, 0, text, 4);
  update();
  dispose?.();
  expect(registry.size).toBe(0);
  expect(selection.toString()).toBe("重要内容");
  expect(host.hasAttribute("data-compact-selection")).toBe(false);
  update();
  expect(registry.size).toBe(0);
});

it("leaves selection outside the translation and unsupported browsers native", () => {
  const outside = document.createElement("p");
  outside.textContent = "原文";
  document.body.append(outside);
  const range = document.createRange();
  range.selectNodeContents(outside);
  window.getSelection()!.addRange(range);
  update();
  expect(highlighted()).toEqual([]);
  expect(host.hasAttribute("data-compact-selection")).toBe(false);
  outside.remove();
  dispose?.();
  vi.stubGlobal("Highlight", undefined);
  expect(installTranslationSelectionHighlight(host)).toBeUndefined();
  expect(host.hasAttribute("data-compact-selection")).toBe(false);
});

it("selects a touched formula whole and releases it when the selection clears", () => {
  host.innerHTML =
    '<p>maps <span class="katex"><span>x</span><span>1</span></span> to</p>';
  const formula = host.querySelector<HTMLElement>(".katex")!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(
    host.querySelector("p")!.firstChild!,
    1,
    formula.firstChild!.firstChild!,
    1,
  );
  update();
  expect(formula.dataset.formulaHighlight).toBe(
    "neoread-translation-selection",
  );
  selection.collapseToStart();
  update();
  expect(formula.hasAttribute("data-formula-highlight")).toBe(false);
});
