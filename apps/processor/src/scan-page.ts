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

// OCR sometimes repeats a selectable page number/header. Preserve that
// original text and its geometry rather than indexing the same line twice.
export function addScanText(native: TextSpan[], ocr: TextSpan[]) {
  if (!native.length) return ocr;
  return native.concat(
    ocr.filter(
      (o) =>
        !native.some((n) => {
          const overlap = intersection(n.bounds, o.bounds);
          return (
            overlap >
              0.5 *
                Math.min(
                  n.bounds.width * n.bounds.height,
                  o.bounds.width * o.bounds.height,
                ) &&
            o.text.replace(/\s/g, "").includes(n.text.replace(/\s/g, ""))
          );
        }),
    ),
  );
}
