import type { PDFPageProxy } from "pdfjs-dist";

/** Use PDF.js's own dependency bounds, as its optimized detail renderer does. */
export function pdfCropOperations(
  page: Pick<PDFPageProxy, "recordedBBoxes">,
  bounds: { x: number; y: number; width: number; height: number },
) {
  const boxes = page.recordedBBoxes;
  if (!boxes) return undefined;
  const left = bounds.x - 0.002,
    top = bounds.y - 0.002;
  const right = bounds.x + bounds.width + 0.002,
    bottom = bounds.y + bounds.height + 0.002;
  return (index: number) =>
    !boxes.isEmpty(index) &&
    boxes.minX(index) <= right &&
    boxes.maxX(index) >= left &&
    boxes.minY(index) <= bottom &&
    boxes.maxY(index) >= top;
}
