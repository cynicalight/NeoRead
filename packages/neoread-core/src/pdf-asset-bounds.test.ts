import { expect, it } from "vitest";
import { pdfAssetBounds } from "./pdf-asset-bounds";
import { pdfFontAscent, pdfFontHeight } from "./pdf-text";
import fixture from "../../../apps/processor/src/fixtures/attack-baseline-axis.json";

it("includes the complete Step label from the reported paper and keeps its neighboring caption separate", () => {
  const { viewport } = fixture;
  const spans = fixture.items.map((item) => ({
    text: item.text,
    bounds: {
      x: item.transform[4] / viewport.width,
      y:
        (viewport.height -
          item.transform[5] -
          item.transform[3] * pdfFontAscent(item.style)) /
        viewport.height,
      width: item.width / viewport.width,
      height: (item.transform[3] * pdfFontHeight(item.style)) / viewport.height,
    },
  }));
  const before = structuredClone(fixture.regions);
  const bounds = pdfAssetBounds(fixture.regions, spans);
  const index = fixture.regions.findIndex((r) => r.id === "p4-b3");
  const step = spans.find((s) => s.text === "Step")!.bounds;
  expect(step.y + step.height).toBeGreaterThan(
    before[index].bounds.y + before[index].bounds.height,
  );
  expect(bounds[index].y + bounds[index].height).toBeCloseTo(
    step.y + step.height,
  );
  const captionIndex = fixture.regions.findIndex((r) => r.id === "p4-b5");
  expect(bounds[captionIndex]).toEqual(before[captionIndex].bounds);
  expect(fixture.regions).toEqual(before);
});

it("expands a crossing axis label while preserving text owned by neighboring prose", () => {
  const regions = [
    { label: "chart", bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
    { label: "text", bounds: { x: 0.38, y: 0.1, width: 0.5, height: 0.4 } },
  ];
  const bounds = pdfAssetBounds(regions, [
    { text: "axis", bounds: { x: 0.2, y: 0.39, width: 0.08, height: 0.03 } },
    {
      text: "neighboring prose",
      bounds: { x: 0.38, y: 0.15, width: 0.45, height: 0.02 },
    },
    { text: "unrelated", bounds: { x: 0.1, y: 0.7, width: 0.3, height: 0.02 } },
  ]);
  expect(bounds[0].x).toBe(0.1);
  expect(bounds[0].y).toBe(0.1);
  expect(bounds[0].width).toBeCloseTo(0.3);
  expect(bounds[0].height).toBeCloseTo(0.32);
  expect(bounds[1]).toEqual(regions[1].bounds);
});
