import { expect, it } from "vitest";
import type { PDFBlock } from "@neoread/core";
import { splitLegacyCaptions, type CaptionSpan } from "./pdf-captions";

const block: PDFBlock = {
  id: "table",
  page: 1,
  label: "table",
  image: "table.png",
  caption: "Table 5: Results",
  text: "data Table 5: Results",
  bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.5 },
};
const span = (text: string, y: number): CaptionSpan => ({
  text,
  box: { x: 10, y, width: 60, height: 10 },
});
it.each([10, 50])(
  "recovers a caption at y=%s using its original coordinates and translation ID",
  (y) => {
    const original = structuredClone(block);
    const recovered = splitLegacyCaptions(
      [block],
      [span("Table 5: Results", y), span("data", 30)],
      100,
      100,
    );
    expect(recovered.unresolved).toEqual([]);
    const caption = recovered.blocks[1];
    expect(caption).toMatchObject({
      id: block.id,
      label: "figure_title",
      text: block.caption,
      bounds: { x: 0.1, y: y / 100, width: 0.6, height: 0.1 },
    });
    expect(caption.image).toBeUndefined();
    expect(recovered.blocks[0].image).toBe(block.image);
    expect(block).toEqual(original);
  },
);
it.each([
  [span("Table 5: Results", 10), span("Table 5: Results", 50)],
  [span("Table 5:", 50)],
  [span("prefix Table 5: Results", 50)],
  [span("Table 5: Results", 30)],
  [span("Table 5: Results", 50), span("data", 45)],
])(
  "preserves ambiguous, partial, interior or overlapping captions and reports the block",
  (...spans) => {
    expect(splitLegacyCaptions([block], spans, 100, 100)).toEqual({
      blocks: [block],
      unresolved: [block.id],
    });
  },
);
it("passes independent caption paragraphs through without changing their coordinates", () => {
  const caption = {
    ...block,
    image: undefined,
    caption: undefined,
    label: "figure_title",
  };
  expect(splitLegacyCaptions([caption], [], 100, 100)).toEqual({
    blocks: [caption],
    unresolved: [],
  });
});
