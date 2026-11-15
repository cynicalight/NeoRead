import { expect, it } from "vitest";
import { pdfModeLocation, savePDFProgress } from "./pdf-progress";

it("resumes the latest reflow paragraph at the same page and coordinates in every mode", () => {
  const progress = savePDFProgress({
    type: "pdf",
    page: 9,
    x: 0.2,
    y: 0.6,
    reflowBlockId: "p9-b4",
  });
  expect(progress).toEqual({
    type: "pdf",
    page: 9,
    x: 0.2,
    y: 0.6,
    reflowPosition: { page: 9, blockId: "p9-b4" },
  });
  expect(pdfModeLocation(progress, false)).toEqual({
    type: "pdf",
    page: 9,
    x: 0.2,
    y: 0.6,
  });
  expect(pdfModeLocation(progress, true)).toEqual({
    type: "pdf",
    page: 9,
    x: 0.2,
    y: 0.6,
    reflowBlockId: "p9-b4",
  });
});

it("uses the current native paragraph instead of retaining an earlier reflow history", () => {
  const current = {
    type: "pdf" as const,
    page: 6,
    x: 0.1,
    y: 0.4,
    reflowPosition: { page: 6, blockId: "p6-b2" },
  };
  expect(savePDFProgress(current)).toEqual(current);
  expect(pdfModeLocation(current, true)).toMatchObject({
    page: 6,
    reflowBlockId: "p6-b2",
  });
});

it("keeps an unparsed page usable in either presentation without a stale paragraph", () => {
  const progress = savePDFProgress({
    type: "pdf",
    page: 10,
    x: 0.1,
    y: 0.4,
    reflowPosition: { page: 9, blockId: "p9-b4" },
  });
  expect(progress).toEqual({ type: "pdf", page: 10, x: 0.1, y: 0.4 });
  expect(pdfModeLocation(progress, true)).toEqual(progress);
});

it("reads legacy positions without resurrecting a separate reflow page", () => {
  expect(
    pdfModeLocation(
      {
        type: "pdf",
        page: 4,
        reflowPosition: { page: 9, blockId: "p9-b4" },
      },
      true,
    ),
  ).toEqual({ type: "pdf", page: 4 });
  const legacy = { type: "pdf" as const, page: 9, reflowBlockId: "p9-b4" };
  expect(pdfModeLocation(legacy, false)).toEqual({ type: "pdf", page: 9 });
  expect(pdfModeLocation(legacy, true)).toEqual(legacy);
  expect(pdfModeLocation(undefined, true)).toBeUndefined();
});
