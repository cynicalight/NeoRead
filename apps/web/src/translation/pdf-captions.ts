import type { PDFBlock } from "@neoread/core";
import { overlaps, type Rect } from "./pdf-layout";

export interface CaptionSpan {
  text: string;
  box: Rect;
}

const compact = (text: string) =>
  text.normalize("NFKC").replace(/[\s\u00ad-]+/gu, "");

/** Recover a legacy caption without modifying the stored blocks or translations.
 * Only a unique, complete sequence at the top/bottom of its asset is accepted.
 */
export function splitLegacyCaptions(
  blocks: PDFBlock[],
  spans: CaptionSpan[],
  width: number,
  height: number,
): { blocks: PDFBlock[]; unresolved: string[] } {
  const unresolved: string[] = [];
  const result = blocks.flatMap((block): PDFBlock[] => {
    if (!block.image || !block.caption?.trim()) return [block];
    const b = block.bounds;
    const outer = {
      x: b.x * width,
      y: b.y * height,
      width: b.width * width,
      height: b.height * height,
    };
    const candidates = spans.filter(
      (s) => overlaps(s.box, outer) && compact(s.text),
    );
    const source = candidates.map((s) => compact(s.text)).join("");
    const target = compact(block.caption);
    const start = source.indexOf(target);
    if (!target || start < 0 || source.indexOf(target, start + 1) !== -1) {
      unresolved.push(block.id);
      return [block];
    }
    let offset = 0;
    const selected = candidates.filter((span) => {
      const from = offset;
      offset += compact(span.text).length;
      return from >= start && offset <= start + target.length;
    });
    if (
      !selected.length ||
      selected.map((s) => compact(s.text)).join("") !== target
    ) {
      unresolved.push(block.id);
      return [block];
    }
    const x = Math.min(...selected.map((s) => s.box.x));
    const y = Math.min(...selected.map((s) => s.box.y));
    const right = Math.max(...selected.map((s) => s.box.x + s.box.width));
    const bottom = Math.max(...selected.map((s) => s.box.y + s.box.height));
    const box = { x, y, width: right - x, height: bottom - y };
    const others = candidates.filter((s) => !selected.includes(s));
    // Preserve a full-width strip for the asset, with an explicit gap around
    // the caption's erasure fringe. Never cut through another text span.
    const above = y - outer.y;
    const below = outer.y + outer.height - bottom;
    const atTop = above <= 4 && others.every((s) => s.box.y > bottom + 1.5);
    const atBottom =
      below <= 4 && others.every((s) => s.box.y + s.box.height < y - 1.5);
    if (
      above < -4 ||
      below < -4 ||
      x < outer.x - 4 ||
      right > outer.x + outer.width + 4 ||
      (!atTop && !atBottom) ||
      others.some((s) => overlaps(s.box, box))
    ) {
      unresolved.push(block.id);
      return [block];
    }
    const assetBounds = atTop
      ? {
          ...b,
          y: (bottom + 1.5) / height,
          height: (outer.y + outer.height - bottom - 1.5) / height,
        }
      : { ...b, height: (y - 1.5 - outer.y) / height };
    if (assetBounds.height <= 0) {
      unresolved.push(block.id);
      return [block];
    }
    return [
      {
        ...block,
        id: `${block.id}:asset`,
        bounds: assetBounds,
        caption: undefined,
      },
      {
        id: block.id,
        page: block.page,
        label: "figure_title",
        text: block.caption,
        bounds: {
          x: x / width,
          y: y / height,
          width: box.width / width,
          height: box.height / height,
        },
      },
    ];
  });
  return { blocks: result, unresolved };
}
