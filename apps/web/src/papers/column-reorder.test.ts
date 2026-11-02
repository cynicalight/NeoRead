// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { beginColumnReorder } from "./column-reorder";

function fixture(vertical = false, rows = 0, gap = 0) {
  const container = document.createElement(vertical ? "div" : "table");
  container.className = vertical ? "paper-columns-popover" : "paper-table";
  const columns = ["title", "authors", "year"] as const;
  container.innerHTML = vertical
    ? columns
        .map(
          (c) =>
            `<div class="paper-column-option" data-column="${c}">${c}</div>`,
        )
        .join("")
    : `<thead><tr>${columns.map((c) => `<th data-column="${c}">${c}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: rows }, () => `<tr>${columns.map((c) => `<td data-column="${c}">${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  document.body.append(container);
  let start = 100;
  const measures = [
    ...container.querySelectorAll<HTMLElement>(
      vertical ? ".paper-column-option" : "th",
    ),
  ].map((el, i) => {
    const size = vertical ? 32 : [300, 180, 60][i];
    const rect = {
      left: start,
      top: start,
      width: size,
      height: size,
    } as DOMRect;
    start += size + gap;
    return vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect);
  });
  const source = container.querySelector<HTMLElement>('[data-column="year"]')!;
  return { container, source, measures };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("moves adjacent whole columns before drop while keeping table DOM stable", () => {
  const { container, source } = fixture(false, 1000);
  const drag = beginColumnReorder(
    source,
    ["title", "authors", "tags", "year"],
    false,
  );
  drag.update(120);
  expect(drag.order).toEqual(["year", "title", "authors", "tags"]);
  expect(container.style.getPropertyValue("--column-title")).toBe("60px");
  expect(container.style.getPropertyValue("--column-authors")).toBe("60px");
  expect(container.style.getPropertyValue("--column-year")).toBe("-480px");
  expect(
    [...container.querySelectorAll("th")].map((el) => el.textContent),
  ).toEqual(["title", "authors", "year"]);
  // One rule reaches every row; dragging does not write thousands of cell styles.
  expect(container.querySelectorAll("td[style]")).toHaveLength(0);
  expect(document.querySelector("style")!.textContent).toContain(
    '[data-column="authors"]',
  );
  drag.cleanup();
  expect(container.hasAttribute("data-column-reordering")).toBe(false);
  expect(container.style.getPropertyValue("--column-title")).toBe("");
  expect(document.querySelector("style")).toBeNull();
});

it("does not measure or rewrite styles for repeated movement within a slot", () => {
  const { container, source, measures } = fixture();
  const drag = beginColumnReorder(source, ["title", "authors", "year"], false);
  drag.update(120);
  const write = vi.spyOn(container.style, "setProperty");
  for (let i = 0; i < 100; i++) drag.update(120 + i);
  expect(write).not.toHaveBeenCalled();
  for (const measure of measures) expect(measure).toHaveBeenCalledTimes(1);
  drag.update(630);
  expect(drag.order).toEqual(["title", "authors", "year"]);
  expect(container.style.getPropertyValue("--column-title")).toBe("0px");
  drag.cleanup();
});

it("slides picker items vertically and accounts for scrolling without moving the drag source", () => {
  const { container, source } = fixture(true);
  const drag = beginColumnReorder(source, ["title", "authors", "year"], true);
  drag.update(105);
  expect(drag.order).toEqual(["year", "title", "authors"]);
  expect(container.style.getPropertyValue("--column-title")).toBe("32px");
  container.scrollTop = 64;
  drag.update(105);
  expect(drag.order).toEqual(["title", "authors", "year"]);
  expect(document.querySelector("style")!.textContent).toContain("translateY");
  expect(document.querySelector("style")!.textContent).toContain(
    ':root:not([data-reduced-motion="true"])',
  );
  drag.cleanup();
});

it("preserves picker spacing while moving and when returning to the original slot", () => {
  const { container, source } = fixture(true, 0, 10);
  const drag = beginColumnReorder(source, ["title", "authors", "year"], true);
  drag.update(105);
  expect(container.style.getPropertyValue("--column-title")).toBe("42px");
  expect(container.style.getPropertyValue("--column-authors")).toBe("42px");
  expect(container.style.getPropertyValue("--column-year")).toBe("-84px");
  drag.update(190);
  expect(drag.order).toEqual(["title", "authors", "year"]);
  for (const column of ["title", "authors", "year"]) {
    expect(container.style.getPropertyValue(`--column-${column}`)).toBe("0px");
  }
  drag.cleanup();
});
