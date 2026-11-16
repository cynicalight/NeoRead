// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SentenceHover } from "./sentence-hover";

let host: HTMLDivElement, hover: SentenceHover;
const registry = new Map<string, Set<Range>>();
const name = "test-sentence-hover";
const range = (node: Node = host.firstChild!) => {
  const r = document.createRange();
  r.selectNodeContents(node);
  return r;
};
beforeEach(() => {
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  host = document.createElement("div");
  host.textContent = "Original sentence.";
  document.body.append(host);
  hover = new SentenceHover(host, name);
});
afterEach(() => {
  hover.destroy();
  host.remove();
  registry.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps source and translation highlights bound to their text ranges across scrolling", () => {
  const source = range();
  const translated = document.createElement("div");
  translated.textContent = "译文句子。";
  host.append(translated);
  const target = range(translated.firstChild!);
  hover.show("sentence", [source, target]);
  expect([...registry.get(name)!].map((r) => r.toString())).toEqual([
    "Original sentence.",
    "译文句子。",
  ]);
  host.scrollTop = 100;
  host.dispatchEvent(new Event("scroll"));
  expect([...registry.get(name)!]).toEqual([source, target]);
});

it("replaces stale ranges after text is re-rendered without touching other highlights", () => {
  const saved = new Set([range()]);
  registry.set("saved-annotation", saved);
  hover.show("same-sentence", [range()]);
  host.textContent = "Re-rendered sentence.";
  const replacement = range();
  hover.invalidate();
  hover.show("same-sentence", [replacement]);
  expect([...registry.get(name)!]).toEqual([replacement]);
  hover.clear();
  expect(registry.has(name)).toBe(false);
  expect(registry.get("saved-annotation")).toBe(saved);
});

it("cleans up only its own reader's hover", () => {
  const other = new SentenceHover(host, "other-reader-hover");
  try {
    hover.show("first", [range()]);
    other.show("second", [range()]);
    hover.destroy();
    expect(registry.has(name)).toBe(false);
    expect(registry.has("other-reader-hover")).toBe(true);
  } finally {
    other.destroy();
  }
});

it("highlights whole formulas and preserves saved formula marks on cleanup", () => {
  host.innerHTML =
    '<span class="katex" data-formula-highlight="saved"><span>x</span></span>';
  const formula = host.firstElementChild!;
  hover.show("formula", [range(formula.firstChild!.firstChild!)]);
  expect(formula.getAttribute("data-formula-highlight")?.split(" ")).toContain(
    name,
  );
  hover.clear();
  expect(formula.getAttribute("data-formula-highlight")).toBe("saved");
});

it("does not highlight text in the hidden original PDF pane", () => {
  host.inert = true;
  host.setAttribute("inert", "");
  hover.show("hidden", [range()]);
  expect(registry.has(name)).toBe(false);
});
