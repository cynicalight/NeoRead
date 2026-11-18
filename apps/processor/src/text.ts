import { pdfFontAscent } from "../../../packages/neoread-core/src/pdf-text";
import type { PDFPageProxy } from "pdfjs-dist";
import type { TextSpan } from "./layout";

export async function extractTextSpans(
  page: PDFPageProxy,
  scale = 1,
): Promise<TextSpan[]> {
  const { Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width),
    height = Math.ceil(viewport.height);
  const content = await page.getTextContent();
  const spans: TextSpan[] = [];
  const rows = new Map<number, TextSpan[]>();
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const transform = Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(transform[2], transform[3]);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    const x = transform[4];
    const y = transform[5] - h * ascent;
    const w = Math.abs(item.width * scale);
    const bounds = {
      x: x / width,
      y: y / height,
      width: w / width,
      height: h / height,
    };
    // Only nearly coincident copies are overprint. A repeat elsewhere is text.
    // Index by PDF-point rows so comparisons stay local, regardless of scale.
    const row = Math.floor(y / scale);
    const tolerance = Math.min(scale, h * 0.1);
    const horizontal = Math.min(tolerance, w * 0.1) / width;
    const vertical = tolerance / height;
    let overprinted = false;
    for (let nearby = row - 1; nearby <= row + 1 && !overprinted; nearby++) {
      overprinted =
        rows
          .get(nearby)
          ?.some(
            (span) =>
              span.text === item.str &&
              Math.abs(span.bounds.x - bounds.x) <= horizontal &&
              Math.abs(span.bounds.y - bounds.y) <= vertical &&
              Math.abs(span.bounds.width - bounds.width) <= horizontal &&
              Math.abs(span.bounds.height - bounds.height) <= vertical,
          ) ?? false;
    }
    if (overprinted) continue;
    const span = { text: item.str, bounds };
    spans.push(span);
    const existing = rows.get(row);
    if (existing) existing.push(span);
    else rows.set(row, [span]);
  }
  return spans;
}
