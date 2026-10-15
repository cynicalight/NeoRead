export type PDFDarkImageMode = "preserve" | "invert" | "adaptive";
export type PDFDarkContrast = "high" | "soft";

export function pdfDarkPalette(contrast: PDFDarkContrast = "soft") {
  return contrast === "high"
    ? { background: "#000000", foreground: "#ffffff" }
    : { background: "#242424", foreground: "#dedede" };
}

export interface PDFDarkRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clip full-page regions to the CSS viewport occupied by a PDF.js detail canvas. */
export function cropPDFRegions(
  regions: PDFDarkRegion[],
  viewport: PDFDarkRegion,
) {
  if (viewport.width <= 0 || viewport.height <= 0) return [];
  return regions.flatMap((region) => {
    const left = Math.max(region.x, viewport.x);
    const top = Math.max(region.y, viewport.y);
    const right = Math.min(
      region.x + region.width,
      viewport.x + viewport.width,
    );
    const bottom = Math.min(
      region.y + region.height,
      viewport.y + viewport.height,
    );
    if (right <= left || bottom <= top) return [];
    return [
      {
        x: (left - viewport.x) / viewport.width,
        y: (top - viewport.y) / viewport.height,
        width: (right - left) / viewport.width,
        height: (bottom - top) / viewport.height,
      },
    ];
  });
}

export interface PDFDarkImageCoordinates {
  /** PDF.js records three corners of each image in normalized canvas space. */
  coordinates?: ArrayLike<number> | null;
}

function rgbToHsl(r: number, g: number, b: number) {
  ((r /= 255), (g /= 255), (b /= 255));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  const l = (max + min) / 2;
  let s = 0;
  if (delta) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
    if (h < 0) h++;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h * 6;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return [r, g, b].map((channel) => Math.round((channel + m) * 255));
}

/** Adapt grayscale to the selected contrast while preserving colored hues. */
export function adaptPDFColor(
  r: number,
  g: number,
  b: number,
  contrast: PDFDarkContrast = "soft",
) {
  const { h, s, l } = rgbToHsl(r, g, b);
  let nextL = contrast === "high" ? 1 - l : 0.14 + (0.87 - 0.14) * (1 - l);
  // Give colored text enough brightness to remain legible on charcoal.
  if (s > 0.08) return hslToRgb(h, s, Math.min(0.87, Math.max(0.64, nextL)));
  return hslToRgb(
    h,
    s,
    contrast === "high" ? nextL : Math.min(0.87, Math.max(0.14, nextL)),
  );
}

function makeMask(width: number, height: number, regions: PDFDarkRegion[]) {
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x * width));
    const top = Math.max(0, Math.floor(region.y * height));
    const right = Math.min(width, Math.ceil((region.x + region.width) * width));
    const bottom = Math.min(
      height,
      Math.ceil((region.y + region.height) * height),
    );
    for (let y = top; y < bottom; y++)
      mask.fill(1, y * width + left, y * width + right);
  }
  return mask;
}

export function imageRegions(data: PDFDarkImageCoordinates): PDFDarkRegion[] {
  const coordinates = data.coordinates;
  if (!coordinates) return [];
  const regions: PDFDarkRegion[] = [];
  for (let i = 0; i + 5 < coordinates.length; i += 6) {
    const xs = [coordinates[i], coordinates[i + 2], coordinates[i + 4]];
    const ys = [coordinates[i + 1], coordinates[i + 3], coordinates[i + 5]];
    const x = Math.max(0, Math.min(...xs));
    const y = Math.max(0, Math.min(...ys));
    const right = Math.min(1, Math.max(...xs));
    const bottom = Math.min(1, Math.max(...ys));
    if (right > x && bottom > y)
      regions.push({ x, y, width: right - x, height: bottom - y });
  }
  return regions;
}

/** Process a fresh ImageData buffer from PDF.js; never uses a processed canvas as input. */
export function processPDFPagePixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  bitmapRegions: PDFDarkRegion[],
  figureRegions: PDFDarkRegion[],
  mode: PDFDarkImageMode,
  contrast: PDFDarkContrast = "soft",
) {
  const output = source;
  const bitmapMask = makeMask(width, height, bitmapRegions);
  const figureMask = makeMask(width, height, figureRegions);
  // Most paper and text pixels are neutral. Avoid HSL conversion and per-pixel
  // allocations for these, especially on Retina canvases during fast scrolling.
  const grayscale = Uint8Array.from({ length: 256 }, (_, value) =>
    Math.round(
      contrast === "high" ? 255 - value : 0.14 * 255 + 0.73 * (255 - value),
    ),
  );
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4;
    const alpha = source[i + 3] / 255;
    const originalR = Math.round(source[i] * alpha + 255 * (1 - alpha));
    const originalG = Math.round(source[i + 1] * alpha + 255 * (1 - alpha));
    const originalB = Math.round(source[i + 2] * alpha + 255 * (1 - alpha));
    if (bitmapMask[pixel]) {
      if (mode !== "invert") {
        output[i] = originalR;
        output[i + 1] = originalG;
        output[i + 2] = originalB;
        output[i + 3] = 255;
        continue;
      }
      output[i] = 255 - originalR;
      output[i + 1] = 255 - originalG;
      output[i + 2] = 255 - originalB;
      output[i + 3] = 255;
      continue;
    }
    if (figureMask[pixel] && mode === "preserve") {
      output[i] = originalR;
      output[i + 1] = originalG;
      output[i + 2] = originalB;
      output[i + 3] = 255;
      continue;
    }
    if (figureMask[pixel] && mode === "invert") {
      output[i] = 255 - originalR;
      output[i + 1] = 255 - originalG;
      output[i + 2] = 255 - originalB;
      output[i + 3] = 255;
      continue;
    }
    if (originalR === originalG && originalG === originalB) {
      output[i] = output[i + 1] = output[i + 2] = grayscale[originalR];
      output[i + 3] = 255;
      continue;
    }
    const [r, g, b] = adaptPDFColor(originalR, originalG, originalB, contrast);
    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
    output[i + 3] = 255;
  }
  return output;
}
