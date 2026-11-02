import type { Document } from "@neoread/core";

export function bodyReadingProgress(document: Document): number | undefined {
  const end = document.bodyEnd;
  if (!end) return undefined;
  const length = end.page - 1 + end.y;
  if (length <= 0) return undefined;
  if (document.percentage === 0) return 0;
  const location = document.progress;
  if (location?.type !== "pdf") return document.percentage >= 1 ? 1 : undefined;
  // PDF page-only locations refer to the page's start, including the initial
  // page=1 event emitted when opening a document.
  const position = location.page - 1 + (location.y ?? 0);
  return Math.min(1, Math.max(0, position / length));
}
