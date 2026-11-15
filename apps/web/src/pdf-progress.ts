import type { PDFLocation } from "@neoread/core";

export function pdfModeLocation(
  progress: PDFLocation | undefined,
  reflow: boolean,
): PDFLocation | undefined {
  if (!progress) return;
  const { reflowBlockId, reflowPosition, ...location } = progress;
  const blockId =
    reflowBlockId ??
    (reflowPosition?.page === location.page
      ? reflowPosition.blockId
      : undefined);
  return reflow && blockId ? { ...location, reflowBlockId: blockId } : location;
}

/** Save one current paragraph in both PDF coordinate and text projections. */
export function savePDFProgress(current: PDFLocation): PDFLocation {
  const { reflowBlockId, reflowPosition, ...location } = current;
  const blockId =
    reflowBlockId ??
    (reflowPosition?.page === location.page
      ? reflowPosition.blockId
      : undefined);
  return blockId
    ? { ...location, reflowPosition: { page: location.page, blockId } }
    : location;
}
