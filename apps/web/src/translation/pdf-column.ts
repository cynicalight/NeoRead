import type { PDFBlock } from "@neoread/core";
import { READING_MARGIN } from "../appearance";

/** Focus Block zooms a text block to fit, up to this scale. */
const FOCUS_MAX_SCALE = 1.5;
const BODY_LABELS = new Set(["text", "abstract", "paragraph", "list"]);

/**
 * Width in CSS pixels of a typical body text block after Focus Block reaches
 * its maximum zoom. Computed once per document; PDF zoom does not change it.
 */
export function pdfFocusWidth(
  blocks: Pick<PDFBlock, "bounds" | "label" | "text">[],
  pageWidth: number | undefined,
) {
  if (!pageWidth) return undefined;
  const text = blocks.filter((b) => b.text.trim() && b.bounds.width > 0);
  const body = text.filter((b) => BODY_LABELS.has(b.label));
  const widths = (body.length ? body : text)
    .map((b) => b.bounds.width)
    .sort((a, b) => a - b);
  if (!widths.length) return undefined;
  const median = widths[Math.floor(widths.length / 2)];
  return Math.round(median * pageWidth * FOCUS_MAX_SCALE);
}

const MIN_COLUMN = 240;

/**
 * Column width for a reading margin: the default margin keeps the focused
 * block width, and each px of margin narrows both sides.
 */
export const pdfTranslationColumn = (
  focusWidth: number,
  margin = READING_MARGIN.default,
) => {
  const m = Math.min(READING_MARGIN.max, Math.max(READING_MARGIN.min, margin));
  return Math.max(MIN_COLUMN, focusWidth - 2 * (m - READING_MARGIN.default));
};
