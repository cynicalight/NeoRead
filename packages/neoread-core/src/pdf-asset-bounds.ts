import type { PDFBlock } from "./index";
type Rect = PDFBlock["bounds"];

const assets = new Set([
  "algorithm",
  "chart",
  "image",
  "table",
  "display_formula",
  "inline_formula",
]);

/** Include complete labels that cross a detected asset edge. Text owned by a
 * neighboring caption/prose block must not enlarge the image. Bounds are normalized.
 */
export function pdfAssetBounds(
  regions: { label: string; bounds: Rect }[],
  spans: { text: string; bounds: Rect }[],
): Rect[] {
  const result = regions.map((r) => ({ ...r.bounds }));
  for (const span of spans) {
    if (!span.text.trim()) continue;
    const s = span.bounds;
    let best = -1,
      score = 0.2;
    regions.forEach((r, i) => {
      const b = r.bounds;
      const overlap =
        (Math.max(
          0,
          Math.min(b.x + b.width, s.x + s.width) - Math.max(b.x, s.x),
        ) *
          Math.max(
            0,
            Math.min(b.y + b.height, s.y + s.height) - Math.max(b.y, s.y),
          )) /
        (s.width * s.height || 1);
      if (overlap > score) {
        best = i;
        score = overlap;
      }
    });
    if (best < 0 || !assets.has(regions[best].label)) continue;
    const b = result[best];
    const x = Math.max(0, Math.min(b.x, s.x)),
      y = Math.max(0, Math.min(b.y, s.y));
    result[best] = {
      x,
      y,
      width: Math.min(1, Math.max(b.x + b.width, s.x + s.width)) - x,
      height: Math.min(1, Math.max(b.y + b.height, s.y + s.height)) - y,
    };
  }
  return result;
}
