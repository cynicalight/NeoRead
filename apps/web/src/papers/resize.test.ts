import { expect, it } from "vitest";
import {
  clampDetailWidth,
  fitColumnWidths,
  resizeBoundary as calculateBoundary,
} from "./resize";

// Explicit minimums keep the cascade examples independent of font metrics.
const minimums = { title: 160, authors: 48, year: 48, status: 48, venue: 48 };
it("fits oversized saved columns to the current pane and keeps the final body-progress column", () => {
  const saved = {
    title: 770,
    published: 106,
    added: 183,
    venue: 708,
    bodyProgress: 112,
  };
  const columns = [
    "title",
    "published",
    "added",
    "venue",
    "bodyProgress",
  ] as const;
  const minimums = {
    title: 72,
    published: 100,
    added: 100,
    venue: 80,
    bodyProgress: 112,
  };
  const fitted = fitColumnWidths(saved, columns, minimums, 800);
  expect(fitted).toEqual({
    title: 408,
    published: 100,
    added: 100,
    venue: 80,
    bodyProgress: 112,
  });
  expect(saved.venue).toBe(708);
  expect(fitColumnWidths(saved, columns, minimums, 2200)).toBe(saved);
  expect(fitColumnWidths(saved, columns, minimums, 0)).toBe(saved);
  const narrow = fitColumnWidths(saved, columns, minimums, 300);
  expect(narrow).toEqual(minimums);
});
const resizeBoundary = (
  widths: Parameters<typeof calculateBoundary>[0],
  left: Parameters<typeof calculateBoundary>[1],
  right: Parameters<typeof calculateBoundary>[2],
  dx: number,
  spareWidth = 0,
) => calculateBoundary(widths, left, right, dx, minimums, spareWidth).widths;

it("moves only the two columns on either side of a boundary", () => {
  const widths = { title: 400, authors: 160, year: 64 };
  expect(resizeBoundary(widths, ["authors"], ["year"], -30)).toEqual({
    authors: 130,
    year: 94,
  });
  // Store both sides, including the title, so table minimum width cannot absorb the drag.
  expect(resizeBoundary(widths, ["title"], ["authors"], 50)).toEqual({
    title: 450,
    authors: 110,
  });
});

it("stops at column minimums when there is no spare width", () => {
  const widths = { title: 200, authors: 160, year: 64 };
  expect(resizeBoundary(widths, ["authors"], ["year"], 100)).toEqual({
    authors: 176,
    year: 48,
  });
  expect(resizeBoundary(widths, ["title"], ["authors"], -500)).toEqual({
    title: 160,
    authors: 200,
  });
});

it("keeps the detail panel within its range", () => {
  expect(clampDetailWidth(100)).toBe(280);
  expect(clampDetailWidth(455.6)).toBe(456);
  expect(clampDetailWidth(2000)).toBe(720);
});

it("resizes a reordered boundary with the title on the right", () => {
  expect(
    resizeBoundary({ authors: 160, title: 200 }, ["authors"], ["title"], 30),
  ).toEqual({ authors: 190, title: 170 });
  expect(
    resizeBoundary({ authors: 160, title: 200 }, ["authors"], ["title"], 90),
  ).toEqual({ authors: 200, title: 160 });
});

it("resizes the last column without taking space from the menu", () => {
  expect(resizeBoundary({ title: 400 }, ["title"], [], 80, 80)).toEqual({
    title: 480,
  });
  expect(resizeBoundary({ title: 400 }, ["title"], [], -800)).toEqual({
    title: 160,
  });
});

it("keeps the flexible title width when resizing the final metadata column", () => {
  expect(
    resizeBoundary({ title: 400, authors: 160 }, ["authors"], [], 40, 40),
  ).toEqual({ title: 400, authors: 200 });
});

it("continues rightward when the neighbouring column is already at its minimum", () => {
  expect(
    resizeBoundary({ title: 496, authors: 48 }, ["title"], ["authors"], 64, 64),
  ).toEqual({ title: 560, authors: 48 });
});

it("freezes the flexible title when a metadata boundary grows the table", () => {
  expect(
    resizeBoundary(
      { title: 400, authors: 160, year: 48 },
      ["authors"],
      ["year"],
      80,
      80,
    ),
  ).toEqual({ title: 400, authors: 240, year: 48 });
});

it("uses visible display order and respects a reordered title minimum", () => {
  expect(
    resizeBoundary(
      { authors: 160, year: 64, status: 72, title: 200, venue: 150 },
      ["authors"],
      ["status", "title"],
      80,
    ),
  ).toEqual({ authors: 224, status: 48, title: 160 });
});

it("stops once all right-hand columns and spare space are exhausted", () => {
  expect(
    resizeBoundary(
      { title: 400, authors: 160, year: 64, status: 72, venue: 150 },
      ["authors"],
      ["year", "status", "venue"],
      500,
    ),
  ).toEqual({ authors: 302, year: 48, status: 48, venue: 48 });
});

it("limits the final column to actual spare width", () => {
  expect(
    resizeBoundary({ title: 400, authors: 160 }, ["authors"], [], 500, 80),
  ).toEqual({ title: 400, authors: 240 });
});

it("compresses earlier visible columns after the immediate left column reaches its minimum", () => {
  expect(
    resizeBoundary(
      { title: 200, authors: 48, year: 64 },
      ["title", "authors"],
      ["year"],
      -24,
    ),
  ).toEqual({ title: 176, authors: 48, year: 88 });
});

it("follows reordered visible columns to the left without touching hidden widths", () => {
  expect(
    resizeBoundary(
      { title: 400, authors: 80, year: 48, status: 64, venue: 80 },
      ["authors", "year"],
      ["status", "venue"],
      -100,
    ),
  ).toEqual({ authors: 48, year: 48, status: 96 });
});

it("can shrink the last boundary through earlier columns into trailing space", () => {
  expect(
    resizeBoundary({ title: 200, authors: 48 }, ["title", "authors"], [], -100),
  ).toEqual({ title: 160, authors: 48 });
});

it("returns remaining space when consuming and releasing it", () => {
  const grown = calculateBoundary(
    { title: 200 },
    ["title"],
    [],
    100,
    { title: 42 },
    80,
  );
  expect(grown).toEqual({ widths: { title: 280 }, spareWidth: 0 });
  const shrunk = calculateBoundary(
    grown.widths,
    ["title"],
    [],
    -300,
    { title: 42 },
    grown.spareWidth,
  );
  expect(shrunk).toEqual({ widths: { title: 42 }, spareWidth: 238 });
});

it("uses each measured minimum in either direction", () => {
  const widths = { title: 200, authors: 160, year: 100 };
  const measured = { title: 42, authors: 76, year: 68 };
  expect(
    calculateBoundary(widths, ["title"], ["authors", "year"], 500, measured),
  ).toEqual({ widths: { title: 316, authors: 76, year: 68 }, spareWidth: 0 });
  expect(
    calculateBoundary(widths, ["title", "authors"], ["year"], -500, measured),
  ).toEqual({ widths: { title: 42, authors: 76, year: 342 }, spareWidth: 0 });
});
