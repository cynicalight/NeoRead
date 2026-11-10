import { expect, it } from "vitest";
import { pdfModeLocation, savePDFProgress } from "./pdf-progress";

it("keeps the original PDF and reflow positions independent across saves", () => {
  const original = { type: "pdf" as const, page: 4, x: 0.2, y: 0.6 };
  const reflow = savePDFProgress(
    original,
    { type: "pdf", page: 9, reflowBlockId: "p9-b4" },
    true,
  );
  expect(reflow).toEqual({
    ...original,
    reflowPosition: { page: 9, blockId: "p9-b4" },
  });
  const movedOriginal = savePDFProgress(
    reflow,
    { type: "pdf", page: 6, x: 0.1, y: 0.4 },
    false,
  );
  expect(movedOriginal).toEqual({
    type: "pdf",
    page: 6,
    x: 0.1,
    y: 0.4,
    reflowPosition: { page: 9, blockId: "p9-b4" },
  });
  expect(pdfModeLocation(movedOriginal, true)).toEqual({
    type: "pdf",
    page: 9,
    reflowBlockId: "p9-b4",
  });
  expect(pdfModeLocation(movedOriginal, false)).toMatchObject({
    page: 6,
    x: 0.1,
    y: 0.4,
  });
  expect(
    savePDFProgress(
      movedOriginal,
      { type: "pdf", page: 10, reflowBlockId: "p10-b2" },
      true,
    ),
  ).toEqual({
    type: "pdf",
    page: 6,
    x: 0.1,
    y: 0.4,
    reflowPosition: { page: 10, blockId: "p10-b2" },
  });
});
