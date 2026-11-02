export type Side = "right" | "bottom" | "left" | "top";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + by * 2,
  height: r.height + by * 2,
});

export const center = (r: Rect) => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** Keep the breathing outline inside the viewport, including its 7px ring. */
export function frameRect(
  target: Rect,
  viewport: { width: number; height: number },
): Rect {
  const expanded = inflate(target, 5);
  const insetX = Math.min(8, viewport.width / 2);
  const insetY = Math.min(8, viewport.height / 2);
  const x = clamp(expanded.x, insetX, viewport.width - insetX);
  const y = clamp(expanded.y, insetY, viewport.height - insetY);
  const right = clamp(expanded.x + expanded.width, x, viewport.width - insetX);
  const bottom = clamp(
    expanded.y + expanded.height,
    y,
    viewport.height - insetY,
  );
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The parts of the viewport outside every hole, as non-overlapping rows of
 * rectangles. One even-odd path cannot do this: overlapping holes, such as a
 * select trigger under its popup, would cancel each other out.
 */
export function blockedRects(
  viewport: { width: number; height: number },
  holes: Rect[],
): Rect[] {
  const visible = holes
    .map((h) => {
      const x = clamp(h.x, 0, viewport.width);
      const y = clamp(h.y, 0, viewport.height);
      return {
        x,
        y,
        width: clamp(h.x + h.width, 0, viewport.width) - x,
        height: clamp(h.y + h.height, 0, viewport.height) - y,
      };
    })
    .filter((h) => h.width > 0 && h.height > 0);
  const xs = [
    ...new Set([
      0,
      viewport.width,
      ...visible.flatMap((h) => [h.x, h.x + h.width]),
    ]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([
      0,
      viewport.height,
      ...visible.flatMap((h) => [h.y, h.y + h.height]),
    ]),
  ].sort((a, b) => a - b);
  const open = (x: number, y: number) =>
    visible.some(
      (h) => x > h.x && x < h.x + h.width && y > h.y && y < h.y + h.height,
    );
  const rects: Rect[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    const y = ys[j];
    const height = ys[j + 1] - y;
    let start: number | null = null;
    for (let i = 0; i < xs.length; i++) {
      const blocked =
        i < xs.length - 1 && !open((xs[i] + xs[i + 1]) / 2, y + height / 2);
      if (blocked && start === null) start = xs[i];
      if (!blocked && start !== null) {
        rects.push({ x: start, y, width: xs[i] - start, height });
        start = null;
      }
    }
  }
  return rects;
}

export const rectsPath = (rects: Rect[]) =>
  rects
    .map((r) => `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}z`)
    .join("");

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Places the coach card beside the anchor (`prefer` first, then right, below,
 * left, above) or in a viewport corner, preferring the first spot that covers
 * none of `clear`. When a full card cannot fit, constrain it to free space
 * and let its content scroll. The card must remain visible.
 */
export function placeCard(
  anchor: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  clear: Rect[] = [],
  prefer?: Side,
  required: Rect[] = [],
): { x: number; y: number; maxWidth?: number; maxHeight?: number } {
  const margin = 16;
  const top = 52;
  const maxX = viewport.width - card.width - margin;
  const maxY = viewport.height - card.height - margin;
  const fit = (p: { x: number; y: number }) => ({
    x: clamp(p.x, margin, maxX),
    y: clamp(p.y, top, maxY),
  });
  if (!anchor) {
    const centered = fit({
      x: (viewport.width - card.width) / 2,
      y: (viewport.height - card.height) / 2,
    });
    if (required.every((r) => overlap({ ...centered, ...card }, r) === 0))
      return centered;
  }
  anchor ??= required[0];
  const gap = 18;
  const sides: Record<Side, { x: number; y: number }> = {
    right: {
      x: anchor.x + anchor.width + gap,
      y: anchor.y + anchor.height / 2 - card.height / 2,
    },
    bottom: {
      x: anchor.x + anchor.width / 2 - card.width / 2,
      y: anchor.y + anchor.height + gap,
    },
    left: {
      x: anchor.x - gap - card.width,
      y: anchor.y + anchor.height / 2 - card.height / 2,
    },
    top: {
      x: anchor.x + anchor.width / 2 - card.width / 2,
      y: anchor.y - gap - card.height,
    },
  };
  const order: Side[] = ["right", "bottom", "left", "top"];
  const beside = (
    prefer ? [prefer, ...order.filter((s) => s !== prefer)] : order
  ).map((side) => sides[side]);
  const corners = [
    { x: maxX, y: maxY },
    { x: maxX, y: top },
    { x: margin, y: maxY },
    { x: margin, y: top },
  ];
  let best = fit(beside[0]);
  let bestCost = Infinity;
  // Rectangle edges also find free strips missed by the usual eight positions.
  const xs = [
    margin,
    maxX,
    ...required.flatMap((r) => [r.x - card.width, r.x + r.width]),
  ];
  const ys = [
    top,
    maxY,
    ...required.flatMap((r) => [r.y - card.height, r.y + r.height]),
  ];
  const fallback = required.length
    ? xs.flatMap((x) => ys.map((y) => ({ x, y })))
    : [];
  for (const [i, spot] of [...beside, ...corners, ...fallback].entries()) {
    const placed = fit(spot);
    const box = { ...placed, ...card };
    if (required.some((r) => overlap(box, r) > 0)) continue;
    // Spots that had to be pushed back into the viewport no longer sit
    // beside the anchor; corners only win when they cover less.
    const moved =
      i < beside.length &&
      (placed.x !== spot.x || placed.y !== spot.y) &&
      overlap(box, anchor) > 0;
    const cost =
      clear.reduce((sum, r) => sum + overlap(box, r), 0) +
      overlap(box, anchor) * 2 +
      (moved ? 1 : 0) +
      (i >= beside.length ? 0.5 : 0);
    if (cost < bestCost) {
      best = placed;
      bestCost = cost;
    }
    if (cost === 0) break;
  }
  if (bestCost !== Infinity) return best;
  const spaces = blockedRects(viewport, required)
    .map((r) => {
      const x = Math.max(margin, r.x);
      const y = Math.max(top, r.y);
      return {
        x,
        y,
        maxWidth: Math.min(card.width, r.x + r.width - margin - x),
        maxHeight: Math.min(card.height, r.y + r.height - margin - y),
      };
    })
    .filter((r) => r.maxWidth >= Math.min(180, card.width) && r.maxHeight >= 48)
    .sort((a, b) => b.maxWidth * b.maxHeight - a.maxWidth * a.maxHeight);
  // Even a physically impossible viewport must not remove the instructions.
  return (
    spaces[0] ?? {
      ...best,
      maxHeight: Math.max(48, viewport.height - top - margin),
    }
  );
}
