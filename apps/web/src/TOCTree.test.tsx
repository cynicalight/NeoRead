// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentLocation, TOCItem } from "@reader/core";
import { activePDFSection, TOCTree } from "./TOCTree";

const pdf = (id: string, page: number, children: TOCItem[] = []): TOCItem => ({
  id,
  label: id,
  location: { type: "pdf", page },
  children,
});
const items = [
  pdf("Introduction", 2),
  pdf("Methods", 4, [pdf("Setup", 4), pdf("Analysis", 7)]),
  pdf("Conclusion", 12),
];

it("keeps the active nested PDF section between headings and after the last heading", () => {
  expect(activePDFSection(items, 1)).toBeUndefined();
  expect(activePDFSection(items, 3)).toBe("Introduction");
  expect(activePDFSection(items, 4)).toBe("Setup");
  expect(activePDFSection(items, 6)).toBe("Setup");
  expect(activePDFSection(items, 11)).toBe("Analysis");
  expect(activePDFSection(items, 25)).toBe("Conclusion");
  expect(activePDFSection(items, 3)).toBe("Introduction");
  expect(activePDFSection([], 2)).toBeUndefined();
});

it("ignores invalid pages and does not assume outlines are sorted", () => {
  expect(
    activePDFSection(
      [pdf("later", 10), pdf("earlier", 3), pdf("bad", NaN), pdf("zero", 0)],
      12,
    ),
  ).toBe("later");
});

let viewport: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;
let positions: Record<string, [number, number]>;
const go = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = document.createElement("div");
  viewport.dataset.slot = "scroll-area-viewport";
  host = document.createElement("div");
  viewport.append(host);
  document.body.append(viewport);
  root = createRoot(host);
  positions = {
    Introduction: [10, 30],
    Setup: [150, 180],
    Analysis: [220, 250],
    Conclusion: [300, 330],
  };
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const [top, bottom] =
        this === viewport
          ? [0, 100]
          : (positions[this.title] ?? [0, 0]).map(
              (x) => x - viewport.scrollTop,
            );
      return {
        top,
        bottom,
        left: 0,
        right: 200,
        width: 200,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON() {},
      };
    },
  );
  go.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  viewport.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(location: DocumentLocation, visible = true, toc = items) {
  await act(async () =>
    root.render(
      <TOCTree items={toc} location={location} go={go} visible={visible} />,
    ),
  );
}

it("reveals a hidden active heading only within the TOC viewport, in both directions", async () => {
  await render({ type: "pdf", page: 13 });
  expect(viewport.scrollTop).toBe(230);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Conclusion12",
  );
  await render({ type: "pdf", page: 3 });
  expect(viewport.scrollTop).toBe(10);
  await act(async () =>
    (host.querySelector('[title="Analysis"]') as HTMLButtonElement).click(),
  );
  expect(go).toHaveBeenCalledExactlyOnceWith({ type: "pdf", page: 7 });
});

it("does not move an already visible heading or undo manual browsing within a section", async () => {
  await render({ type: "pdf", page: 2 });
  expect(viewport.scrollTop).toBe(0);
  viewport.scrollTop = 200;
  await render({ type: "pdf", page: 3, y: 0.8 });
  expect(viewport.scrollTop).toBe(200);
  await render({ type: "pdf", page: 5 });
  expect(viewport.scrollTop).toBe(150);
});

it("waits for the navigation panel to reopen before following the current section", async () => {
  await render({ type: "pdf", page: 13 }, false);
  expect(viewport.scrollTop).toBe(0);
  await render({ type: "pdf", page: 13 }, true);
  expect(viewport.scrollTop).toBe(230);
});

it("preserves EPUB href matching and does not mix PDF page selection into EPUB", async () => {
  const epub: TOCItem[] = [
    {
      id: "epub",
      label: "Chapter",
      location: { type: "epub", href: "chapter.xhtml#heading" },
      children: [],
    },
  ];
  await render(
    { type: "epub", href: "chapter.xhtml#paragraph", progression: 0.8 },
    true,
    epub,
  );
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Chapter",
  );
  await render({ type: "pdf", page: 3 }, true, epub);
  expect(host.querySelector('[aria-current="location"]')).toBeNull();
});

const epubChapters: TOCItem[] = [
  {
    id: "chapter",
    label: "Chapter",
    location: { type: "epub", href: "chapter.xhtml" },
    children: [
      {
        id: "section-a",
        label: "Section A",
        location: { type: "epub", href: "chapter.xhtml#a" },
        children: [],
      },
      {
        id: "section-b",
        label: "Section B",
        location: { type: "epub", href: "chapter.xhtml#b" },
        children: [],
      },
      {
        id: "section-b-alias",
        label: "Section B alias",
        location: { type: "epub", href: "chapter.xhtml#b" },
        children: [],
      },
    ],
  },
];

it("marks and reveals only the first exact EPUB anchor match while preserving file-wide styling", async () => {
  positions.Chapter = [10, 30];
  positions["Section A"] = [150, 180];
  positions["Section B"] = [300, 330];
  positions["Section B alias"] = [400, 430];
  await render({ type: "epub", href: "chapter.xhtml#a" }, true, epubChapters);
  expect(host.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Section A",
  );
  expect(host.querySelectorAll(".toc-item.selected")).toHaveLength(4);
  expect(viewport.scrollTop).toBe(80);

  // Navigating to another anchor in the same file must update the current item.
  await render({ type: "epub", href: "chapter.xhtml#b" }, true, epubChapters);
  expect(host.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Section B",
  );
  expect(viewport.scrollTop).toBe(230);
  viewport.scrollTop = 0;
  await render(
    { type: "epub", href: "chapter.xhtml#b", progression: 0.8 },
    true,
    epubChapters,
  );
  expect(viewport.scrollTop).toBe(0);
});

it("uses one stable EPUB file match for unknown fragments and clears it outside that file", async () => {
  await render(
    { type: "epub", href: "chapter.xhtml#paragraph" },
    true,
    epubChapters,
  );
  expect(host.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Chapter",
  );
  await render({ type: "epub", href: "chapter.xhtml" }, true, epubChapters);
  expect(host.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="location"]')?.textContent).toBe(
    "Chapter",
  );
  await render({ type: "epub", href: "other.xhtml#a" }, true, epubChapters);
  expect(host.querySelector('[aria-current="location"]')).toBeNull();
  expect(host.querySelector(".toc-item.selected")).toBeNull();
});
