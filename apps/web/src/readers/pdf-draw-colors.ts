import type { ReaderTheme } from "@reader/core";
import {
  adaptPDFColor,
  pdfDarkPalette,
  type PDFDarkRegion,
} from "./pdf-dark-mode";

type Context = CanvasRenderingContext2D;
type Ink = Context["fillStyle"];
type Paint = "fill" | "stroke" | "stencil" | { image: number[] };
type Variant = "adaptive" | "invert" | "preserve";
type Rect = [number, number, number, number];

/** Opt-in contract provided by our version-pinned PDF.js patch. */
export interface PDFDrawColors {
  background: string;
  begin(
    ctx: Context,
    viewport: { width: number; height: number },
    transform: number[] | null,
  ): void;
  context(ctx: Context, parent: Context, x: number, y: number): void;
  variants: Variant[];
  shading(ir: unknown[], variant: Variant): unknown[];
  pattern(original: Ink, variants: Partial<Record<Variant, Ink>>): void;
  forPattern(variant: Variant): PDFDrawColors | null;
  paint(ctx: Context, kind: Paint, draw: () => void): void;
}

/** Changes source paint colors, never antialiased page pixels. */
export function pdfDrawColors(
  theme: ReaderTheme,
  figures: PDFDarkRegion[] = [],
  patternVariant?: Exclude<Variant, "preserve">,
): PDFDrawColors | null {
  if (theme.mode !== "dark") return null;
  const mode = theme.pdfDarkImageMode ?? "adaptive";
  const contrast = theme.pdfDarkContrast ?? "soft";
  const palette = pdfDarkPalette(contrast);
  const colors = new Map<string, string>();
  const positions = new WeakMap<Context, { x: number; y: number }>();
  const patterns = new WeakMap<object, Partial<Record<Variant, Ink>>>();
  const imageBackdrops: Rect[] = [];
  let protectedRects: Rect[] = [];

  const map = (ink: Ink, variant: Variant): Ink => {
    if (variant === "preserve") return ink;
    if (typeof ink !== "string") {
      // PDF.js handles image/mesh patterns itself. Do not mistake a bitmap
      // pattern for a text color or recolor its antialiased edges.
      return patterns.get(ink)?.[variant] ?? ink;
    }
    const key = `${variant}:${ink}`;
    const cached = colors.get(key);
    if (cached) return cached;
    const hex = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(ink);
    const rgb =
      /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
        ink,
      );
    if (!hex && !rgb) return ink; // Includes transparent; preserve its alpha.
    const [r, g, b] = hex
      ? [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16))
      : rgb!.slice(1, 4).map(Number);
    const alpha = hex
      ? hex[2]
        ? Number.parseInt(hex[2], 16) / 255
        : 1
      : Number(rgb![4] ?? 1);
    const next =
      variant === "invert"
        ? [255 - r, 255 - g, 255 - b]
        : adaptPDFColor(r, g, b, contrast);
    const result = `rgba(${next.join(",")},${alpha})`;
    if (colors.size < 4096) colors.set(key, result);
    return result;
  };

  const rectPath = (ctx: Context, rects: Rect[]) => {
    const { x, y } = positions.get(ctx) ?? { x: 0, y: 0 };
    const path = new Path2D();
    for (const [left, top, width, height] of rects)
      path.rect(left - x, top - y, width, height);
    return path;
  };
  const clip = (ctx: Context, inside: boolean) => {
    const matrix = ctx.getTransform();
    ctx.resetTransform();
    if (inside) ctx.clip(rectPath(ctx, protectedRects));
    else {
      // Intersect complements individually: overlapping figure boxes must not
      // create holes in their union through an even-odd cancellation.
      for (const rect of protectedRects) {
        const path = new Path2D();
        path.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
        path.addPath(rectPath(ctx, [rect]));
        ctx.clip(path, "evenodd");
      }
    }
    ctx.setTransform(matrix);
  };
  const paint = (
    ctx: Context,
    kind: Paint,
    draw: () => void,
    variant: Variant,
  ) => {
    if (kind === "stencil") {
      // Stencil alpha is already decoded by PDF.js; filter this small source
      // while drawing it, rather than reading a full page back to the CPU.
      if (variant === "preserve") return draw();
      ctx.save();
      try {
        const previous =
          ctx.filter && ctx.filter !== "none" ? `${ctx.filter} ` : "";
        ctx.filter = `${previous}invert(1)${variant === "adaptive" ? ` hue-rotate(180deg)${contrast === "soft" ? " contrast(0.73)" : ""}` : ""}`;
        draw();
      } finally {
        ctx.restore();
      }
      return;
    }
    if (typeof kind === "object") {
      ctx.save();
      try {
        const [x, y, width, height] = kind.image;
        const matrix = ctx.getTransform();
        const origin = positions.get(ctx) ?? { x: 0, y: 0 };
        const corners = [
          [x, y],
          [x + width, y],
          [x, y + height],
          [x + width, y + height],
        ].map(([a, b]) => matrix.transformPoint({ x: a, y: b }));
        const left = Math.min(...corners.map((p) => p.x)) + origin.x;
        const top = Math.min(...corners.map((p) => p.y)) + origin.y;
        const rect: Rect = [
          left,
          top,
          Math.max(...corners.map((p) => p.x)) + origin.x - left,
          Math.max(...corners.map((p) => p.y)) + origin.y - top,
        ];
        // A white backing restores transparent photos/plots on dark paper.
        // Exclude previous image backings so overlapping images retain their
        // transparency relative to earlier images instead of erasing them.
        ctx.save();
        ctx.resetTransform();
        for (const prior of [...protectedRects, ...imageBackdrops]) {
          if (
            prior[0] >= rect[0] + rect[2] ||
            prior[0] + prior[2] <= rect[0] ||
            prior[1] >= rect[1] + rect[3] ||
            prior[1] + prior[3] <= rect[1]
          )
            continue;
          const outside = new Path2D();
          outside.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
          outside.addPath(rectPath(ctx, [prior]));
          ctx.clip(outside, "evenodd");
        }
        ctx.setTransform(matrix);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.filter = "none";
        ctx.fillStyle =
          (patternVariant ?? mode) === "invert" ? "#000000" : "#ffffff";
        ctx.fillRect(x, y, width, height);
        ctx.restore();
        imageBackdrops.push(rect);
        if ((patternVariant ?? mode) === "invert") ctx.filter = "invert(1)";
        draw();
      } finally {
        ctx.restore();
      }
      return;
    }
    const property = kind === "stroke" ? "strokeStyle" : "fillStyle";
    const original = ctx[property];
    const mapped = map(original, variant);
    if (mapped === original) return draw();
    ctx[property] = mapped;
    try {
      draw();
    } finally {
      ctx[property] = original;
    }
  };

  return {
    background: palette.background,
    begin(ctx, viewport, transform) {
      positions.set(ctx, { x: 0, y: 0 });
      const matrix = new DOMMatrix(transform ?? [1, 0, 0, 1, 0, 0]);
      protectedRects =
        mode === "adaptive"
          ? []
          : figures.flatMap((region): Rect[] => {
              const p = matrix.transformPoint({
                x: region.x * viewport.width,
                y: region.y * viewport.height,
              });
              const q = matrix.transformPoint({
                x: (region.x + region.width) * viewport.width,
                y: (region.y + region.height) * viewport.height,
              });
              const left = Math.max(0, Math.min(p.x, q.x));
              const top = Math.max(0, Math.min(p.y, q.y));
              const right = Math.min(ctx.canvas.width, Math.max(p.x, q.x));
              const bottom = Math.min(ctx.canvas.height, Math.max(p.y, q.y));
              return right > left && bottom > top
                ? [[left, top, right - left, bottom - top]]
                : [];
            });
      if (protectedRects.length) {
        ctx.save();
        ctx.resetTransform();
        ctx.fillStyle = mode === "preserve" ? "#ffffff" : "#000000";
        ctx.fill(rectPath(ctx, protectedRects));
        ctx.restore();
      }
    },
    context(ctx, parent, x, y) {
      const origin = positions.get(parent) ?? { x: 0, y: 0 };
      positions.set(ctx, { x: origin.x + x, y: origin.y + y });
    },
    variants: patternVariant
      ? [patternVariant]
      : mode === "adaptive"
        ? ["adaptive"]
        : mode === "invert"
          ? ["adaptive", "invert"]
          : ["adaptive", "preserve"],
    shading(ir, variant) {
      if (variant === "preserve") return ir;
      const result = ir.slice();
      if (ir[0] === "RadialAxial") {
        result[3] = (ir[3] as [number, string][]).map(([stop, color]) => [
          stop,
          map(color, variant),
        ]);
      } else if (ir[0] === "Mesh") {
        const data = (ir[3] as Uint8Array).slice();
        const adapt = (r: number, g: number, b: number) =>
          variant === "invert"
            ? [255 - r, 255 - g, 255 - b]
            : adaptPDFColor(r, g, b, contrast);
        for (let i = 0; i + 2 < data.length; i += 3)
          data.set(adapt(data[i], data[i + 1], data[i + 2]), i);
        result[3] = data;
        if (ir[7]) {
          const [r, g, b] = ir[7] as number[];
          result[7] = adapt(r, g, b);
        }
      }
      return result;
    },
    pattern(original, variants) {
      if (typeof original !== "string") patterns.set(original, variants);
    },
    forPattern(variant) {
      return variant === "preserve" ? null : pdfDrawColors(theme, [], variant);
    },
    paint(ctx, kind, draw) {
      if (typeof kind === "object" || !protectedRects.length) {
        paint(ctx, kind, draw, patternVariant ?? "adaptive");
        return;
      }
      ctx.save();
      try {
        clip(ctx, false);
        paint(ctx, kind, draw, "adaptive");
      } finally {
        ctx.restore();
      }
      ctx.save();
      try {
        clip(ctx, true);
        paint(ctx, kind, draw, mode);
      } finally {
        ctx.restore();
      }
    },
  };
}
