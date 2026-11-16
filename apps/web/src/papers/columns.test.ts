import { expect, it } from "vitest";
import type { PaperLibraryPreferences } from "@neoread/core";
import { columnOrder, moveColumn, showColumn, visibleColumns } from "./columns";

it("keeps existing visible order and normalizes saved hidden columns", () => {
  const prefs = { columns: ["year", "authors"] as const };
  const order = columnOrder({ columns: [...prefs.columns] });
  expect(order.slice(0, 3)).toEqual(["title", "year", "authors"]);
  expect(new Set(order).size).toBe(order.length);
  expect(
    visibleColumns({
      columns: ["year", "authors"],
      columnOrder: ["authors", "title", "year", "authors"],
    }),
  ).toEqual(["authors", "title", "year"]);
  expect(visibleColumns({ columns: [] })).toEqual(["title"]);
});

it("moves before or after a target without mutating or losing hidden positions", () => {
  const order = columnOrder({ columns: ["authors", "year", "tags"] });
  const moved = moveColumn(order, "tags", "title", "before");
  expect(moved.slice(0, 4)).toEqual(["tags", "title", "authors", "year"]);
  expect(order.slice(0, 4)).toEqual(["title", "authors", "year", "tags"]);
  expect(
    visibleColumns({ columns: ["authors", "year"], columnOrder: moved }),
  ).toEqual(["title", "authors", "year"]);
  expect(
    visibleColumns({
      columns: ["authors", "year", "tags"],
      columnOrder: moved,
    }),
  ).toEqual(["tags", "title", "authors", "year"]);
  expect(moveColumn(moved, "title", "year", "after").slice(0, 4)).toEqual([
    "tags",
    "authors",
    "year",
    "title",
  ]);
  expect(moveColumn(order, "tags", "tags", "before")).toBe(order);
});

it("restores a hidden title in its saved position and shows it by default for older settings", () => {
  const prefs = {
    columns: ["authors", "year"] as ("authors" | "year")[],
    columnOrder: ["authors", "title", "year"] as (
      "title" | "authors" | "year"
    )[],
  };
  expect(visibleColumns({ ...prefs, showTitle: false })).toEqual([
    "authors",
    "year",
  ]);
  expect(visibleColumns(prefs)).toEqual(["authors", "title", "year"]);
  expect(visibleColumns({ ...prefs, showTitle: true })).toEqual([
    "authors",
    "title",
    "year",
  ]);
});

it("shows remarks by default and restores their saved position and width after hiding", () => {
  expect(visibleColumns({})).toContain("remark");
  const legacy: PaperLibraryPreferences = {
    columns: ["year", "notes"],
    columnOrder: ["notes", "title", "year", "authors"],
  };
  expect(visibleColumns(legacy)).toEqual(["notes", "title", "year"]);
  expect(columnOrder(legacy).slice(0, 4)).toEqual(legacy.columnOrder);
  expect(columnOrder(legacy).at(-1)).toBe("remark");

  const shown = showColumn(legacy, "remark", true);
  const reordered = {
    ...shown,
    columnOrder: moveColumn(columnOrder(shown), "remark", "notes", "before"),
    columnWidths: { remark: 320, year: 80 },
  };
  const hidden = showColumn(reordered, "remark", false);
  // Preferences cross a JSON boundary when they are saved and loaded.
  const saved: PaperLibraryPreferences = JSON.parse(JSON.stringify(hidden));
  expect(visibleColumns(saved)).toEqual(["notes", "title", "year"]);
  const restored = showColumn(saved, "remark", true);
  expect(visibleColumns(restored)).toEqual(["remark", "notes", "title", "year"]);
  expect(restored.columnWidths).toEqual({ remark: 320, year: 80 });
  expect(legacy.columns).toEqual(["year", "notes"]);
});

it("continues to discard unknown saved columns while accepting remarks", () => {
  const saved: PaperLibraryPreferences = JSON.parse(
    '{"columns":["unknown","remark","notes"],"columnOrder":["unknown","remark","title","notes"]}',
  );
  expect(columnOrder(saved)).not.toContain("unknown");
  expect(visibleColumns(saved)).toEqual(["remark", "title", "notes"]);
  expect(showColumn(saved, "remark", false).columns).toEqual(["notes"]);
});
