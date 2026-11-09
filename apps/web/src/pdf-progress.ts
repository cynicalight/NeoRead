import type { PDFLocation } from "@neoread/core";

export function pdfModeLocation(
  progress: PDFLocation | undefined,
  reflow: boolean,
): PDFLocation | undefined {
  if (!reflow) return progress?.reflowBlockId ? undefined : progress;
  const saved =
    progress?.reflowPosition ??
    (progress?.reflowBlockId
      ? { page: progress.page, blockId: progress.reflowBlockId }
      : undefined);
  return saved
    ? { type: "pdf", page: saved.page, reflowBlockId: saved.blockId }
    : undefined;
}

/** Persist each PDF view independently in the existing document progress. */
export function savePDFProgress(
  previous: PDFLocation | undefined,
  current: PDFLocation,
  reflow: boolean,
): PDFLocation {
  const savedReflow =
    previous?.reflowPosition ??
    (previous?.reflowBlockId
      ? { page: previous.page, blockId: previous.reflowBlockId }
      : undefined);
  const original =
    previous && !previous.reflowBlockId
      ? previous
      : { type: "pdf" as const, page: 1 };
  if (reflow) {
    return {
      ...original,
      reflowPosition: current.reflowBlockId
        ? { page: current.page, blockId: current.reflowBlockId }
        : savedReflow,
    };
  }
  const { reflowBlockId: _, reflowPosition: __, ...location } = current;
  return { ...location, ...(savedReflow && { reflowPosition: savedReflow }) };
}
