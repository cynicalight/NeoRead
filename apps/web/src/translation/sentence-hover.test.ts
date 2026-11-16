// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SentenceHover } from "./sentence-hover";
import { useReaderStore } from "../store";

let host: HTMLDivElement, hover: SentenceHover;
const registry = new Map<string, Set<Range>>();
const name = "test-sentence-hover";
const range = (node: Node = host.firstChild!) => {
  const r = document.createRange();
  r.selectNodeContents(node);
  return r;
};
/** Registered hover layers as `slot-level` → ranges. */
const painted = (prefix = name) =>
  Object.fromEntries(
    [...registry]
      .filter(([key]) => key.startsWith(`${prefix}-`))
      .map(([key, ranges]) => [key.slice(prefix.length + 1), [...ranges]]),
  );
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
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
  useReaderStore.setState((state) => ({
    theme: { ...state.theme, reducedMotion: false },
  }));
  vi.useRealTimers();
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
  vi.advanceTimersByTime(200);
  expect(painted()["0-10"]!.map((r) => r.toString())).toEqual([
    "Original sentence.",
    "译文句子。",
  ]);
  host.scrollTop = 100;
  host.dispatchEvent(new Event("scroll"));
  expect(painted()).toEqual({ "0-10": [source, target] });
});

it("fades in, cross-fades between sentences and fades out", () => {
  host.innerHTML = "<p>First.</p><p>Second.</p>";
  const first = range(host.children[0]!.firstChild!);
  const second = range(host.children[1]!.firstChild!);
  hover.show("first", [first]);
  vi.advanceTimersByTime(48);
  const entering = Object.keys(painted());
  expect(entering).toHaveLength(1);
  expect(entering[0]).toMatch(/^0-[1-9]$/);
  vi.advanceTimersByTime(200);
  expect(painted()).toEqual({ "0-10": [first] });

  hover.show("second", [second]);
  vi.advanceTimersByTime(80);
  const mid = painted();
  expect(Object.values(mid)).toEqual(
    expect.arrayContaining([[first], [second]]),
  );
  vi.advanceTimersByTime(200);
  expect(painted()).toEqual({ "1-10": [second] });

  hover.clear();
  vi.advanceTimersByTime(48);
  expect(Object.keys(painted())[0]).toMatch(/^1-[1-9]$/);
  vi.advanceTimersByTime(200);
  expect(painted()).toEqual({});
});

it("switches instantly when the app reduces motion", () => {
  useReaderStore.setState((state) => ({
    theme: { ...state.theme, reducedMotion: true },
  }));
  const source = range();
  hover.show("sentence", [source]);
  expect(painted()).toEqual({ "0-10": [source] });
  hover.clear();
  expect(painted()).toEqual({});
});

it("replaces stale ranges after text is re-rendered without touching other highlights", () => {
  const saved = new Set([range()]);
  registry.set("saved-annotation", saved);
  hover.show("same-sentence", [range()]);
  vi.advanceTimersByTime(200);
  host.textContent = "Re-rendered sentence.";
  const replacement = range();
  hover.invalidate();
  hover.show("same-sentence", [replacement]);
  expect(painted()).toEqual({ "0-10": [replacement] });
  hover.clear();
  vi.advanceTimersByTime(200);
  expect(painted()).toEqual({});
  expect(registry.get("saved-annotation")).toBe(saved);
});

it("cleans up only its own reader's hover", () => {
  const other = new SentenceHover(host, "other-reader-hover");
  try {
    hover.show("first", [range()]);
    other.show("second", [range()]);
    vi.advanceTimersByTime(200);
    hover.destroy();
    expect(painted()).toEqual({});
    expect(Object.keys(painted("other-reader-hover"))).toEqual(["0-10"]);
  } finally {
    other.destroy();
  }
});

it("highlights whole formulas and preserves saved formula marks on cleanup", () => {
  host.innerHTML =
    '<span class="katex" data-formula-highlight="saved"><span>x</span></span>';
  const formula = host.firstElementChild!;
  hover.show("formula", [range(formula.firstChild!.firstChild!)]);
  vi.advanceTimersByTime(200);
  expect(formula.getAttribute("data-formula-highlight")?.split(" ")).toEqual([
    "saved",
    `${name}-0-10`,
  ]);
  hover.clear();
  vi.advanceTimersByTime(200);
  expect(formula.getAttribute("data-formula-highlight")).toBe("saved");
});

it("does not highlight text in the hidden original PDF pane", () => {
  host.inert = true;
  host.setAttribute("inert", "");
  hover.show("hidden", [range()]);
  vi.advanceTimersByTime(200);
  expect(painted()).toEqual({});
});
