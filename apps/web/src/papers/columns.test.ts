import { expect, it } from "vitest";
import { columnOrder, moveColumn, visibleColumns } from "./columns";

it("defaults to title, tags, publication date, added date, venue and body progress in that order", () => {
  expect(visibleColumns({})).toEqual([
    "title",
    "tags",
    "published",
    "added",
    "venue",
    "bodyProgress",
  ]);
});

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
