import type { PDFOperatorList } from "pdfjs-dist/types/src/display/api";
import { intersection, type Region, type TextSpan } from "./layout";

const body = [
  "text",
  "content",
  "aside_text",
  "abstract",
  "vertical_text",
  "reference_content",
];

// Neither an empty text layer (blank page, photograph) nor an image (logo,
// illustration) alone is evidence of scanned prose. Native body text wins.
export function missingScanText(regions: Region[], native: TextSpan[]) {
  const textRegions = regions.filter(
    (r) => body.includes(r.label) && r.bounds.width * r.bounds.height >= 0.008,
  );
  if (!textRegions.length) return false;
  return !native.some(
    (s) =>
      /[\p{L}\p{N}]/u.test(s.text) &&
      textRegions.some(
        (r) =>
          intersection(s.bounds, r.bounds) >
          0.5 * s.bounds.width * s.bounds.height,
      ),
  );
}

// Track absolute painted area in PDF user space. Image XObjects paint a unit
// square; the determinant includes page/form transforms, including rotation.
export function hasScanImage(
  ops: Pick<PDFOperatorList, "fnArray" | "argsArray">,
  codes: {
    save: number;
    restore: number;
    transform: number;
    paintFormXObjectBegin: number;
    paintFormXObjectEnd: number;
    paintImageXObject: number;
    paintInlineImageXObject: number;
    paintImageMaskXObject: number;
  },
  pageArea: number,
) {
  let area = 1,
    painted = 0;
  const stack: number[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i],
      args = ops.argsArray[i];
    if (op === codes.save) stack.push(area);
    else if (op === codes.restore || op === codes.paintFormXObjectEnd)
      area = stack.pop() ?? 1;
    else if (op === codes.transform)
      area *= Math.abs(args[0] * args[3] - args[1] * args[2]);
    else if (op === codes.paintFormXObjectBegin) {
      stack.push(area);
      const m = args[0];
      if (m) area *= Math.abs(m[0] * m[3] - m[1] * m[2]);
    } else if (
      op === codes.paintImageXObject ||
      op === codes.paintInlineImageXObject ||
      op === codes.paintImageMaskXObject
    ) {
      painted += area;
      if (painted >= pageArea * 0.35) return true;
    }
  }
  return false;
}

// Match an entire OCR line, not a substring: a selectable page number or
// fragment can overlap a longer scanned line whose remaining prose is needed.
export function addScanText(native: TextSpan[], ocr: TextSpan[]) {
  if (!ocr.length) return { spans: native, ocrSpans: undefined };
  if (!native.length) return { spans: ocr, ocrSpans: new Set(ocr) };

  const nativeLines = native
    .map((span) => ({
      bounds: span.bounds,
      text: span.text.normalize("NFKC").replace(/\s/g, ""),
      area: span.bounds.width * span.bounds.height,
    }))
    .sort((a, b) => a.bounds.x - b.bounds.x);
  const ocrSpans = new Set<TextSpan>();
  let spans = native;
  for (const line of ocr) {
    const text = line.text.normalize("NFKC").replace(/\s/g, "");
    if (!text) continue;
    const area = line.bounds.width * line.bounds.height;
    let joined = "";
    let duplicate = false;
    for (const span of nativeLines) {
      if (span.bounds.x >= line.bounds.x + line.bounds.width) break;
      if (
        intersection(span.bounds, line.bounds) <= 0.5 * Math.min(span.area, area)
      )
        continue;
      // PDF.js may split the native header across multiple text items.
      if (span.text === text) {
        duplicate = true;
        break;
      }
      joined += span.text;
    }
    if (duplicate || joined === text) continue;
    if (!ocrSpans.size) spans = native.slice();
    spans.push(line);
    ocrSpans.add(line);
  }
  return { spans, ocrSpans: ocrSpans.size ? ocrSpans : undefined };
}
