import { expect, it } from "vitest";
import type { Document } from "@neoread/core";
import { bodyReadingProgress } from "./body-progress";

it("completes the body at the reference heading, before full-PDF completion", () => {
  const document = {
    percentage: 0.5,
    bodyEnd: { page: 5, y: 0.25 },
    progress: { type: "pdf", page: 5, y: 0.25 },
  } as Document;
  expect(bodyReadingProgress(document)).toBe(1);
  expect(
    bodyReadingProgress({
      ...document,
      progress: { type: "pdf", page: 4, y: 0.5 },
    }),
  ).toBeCloseTo(3.5 / 4.25);
  expect(
    bodyReadingProgress({
      ...document,
      progress: { type: "pdf", page: 8, y: 0.2 },
    }),
  ).toBe(1);
});
it("keeps unread papers at zero and does not invent an end for unparsed papers", () => {
  const document = { percentage: 0, bodyEnd: { page: 5, y: 1 } } as Document;
  expect(bodyReadingProgress(document)).toBe(0);
  expect(
    bodyReadingProgress({ ...document, bodyEnd: undefined }),
  ).toBeUndefined();
});
it("keeps the initial first-page event at zero instead of treating that page as read", () => {
  const document = {
    percentage: 1 / 10,
    bodyEnd: { page: 10, y: 1 },
    progress: { type: "pdf", page: 1 },
  } as Document;
  expect(bodyReadingProgress(document)).toBe(0);
  expect(
    bodyReadingProgress({
      ...document,
      progress: { type: "pdf", page: 1, y: 0 },
    }),
  ).toBe(0);
  expect(
    bodyReadingProgress({
      ...document,
      percentage: 1,
      bodyEnd: { page: 1, y: 1 },
    }),
  ).toBe(0);
});
it("counts completed pages and known page fractions, including the last body page", () => {
  const document = {
    percentage: 0.2,
    bodyEnd: { page: 10, y: 1 },
    progress: { type: "pdf", page: 2 },
  } as Document;
  expect(bodyReadingProgress(document)).toBe(0.1);
  expect(
    bodyReadingProgress({
      ...document,
      progress: { type: "pdf", page: 2, y: 0.5 },
    }),
  ).toBe(0.15);
  expect(
    bodyReadingProgress({
      ...document,
      percentage: 1,
      progress: { type: "pdf", page: 10 },
    }),
  ).toBe(0.9);
  expect(
    bodyReadingProgress({
      ...document,
      percentage: 1,
      progress: { type: "pdf", page: 10, y: 1 },
    }),
  ).toBe(1);
});
