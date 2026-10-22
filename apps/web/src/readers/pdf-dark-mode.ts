export type PDFDarkImageMode = "preserve" | "invert" | "adaptive";
/** "soft" is graphite, recolored onto the dark theme's warm surface; "high" is pure black. */
export type PDFDarkContrast = "high" | "soft";

/** Lightness of recolored paper and ink. */
const lightness = {
  high: [0, 1],
  soft: [0.18, 0.86],
} satisfies Record<PDFDarkContrast, [number, number]>;

/** Tinted paper and ink, replacing the neutral grays at the lightness ends. */
const tints: Partial<
  Record<PDFDarkContrast, { paper: number[]; ink: number[] }>
> = {
  soft: { paper: [0x2f, 0x2c, 0x2f], ink: [0xdc, 0xd7, 0xd2] },
};
const tintTables = new Map<PDFDarkContrast, Uint8Array[] | null>();
/** Per-channel lookup from a neutral recolored value to the tinted one. */
function tintChannels(contrast: PDFDarkContrast) {
  if (tintTables.has(contrast)) return tintTables.get(contrast)!;
  const tint = tints[contrast];
  const [paper, ink] = lightness[contrast].map((value) => value * 255);
  const tables = tint
    ? [0, 1, 2].map((channel) =>
        Uint8Array.from({ length: 256 }, (_, value) =>
          Math.max(
            0,
            Math.min(
              255,
              Math.round(
                tint.paper[channel] +
                  ((tint.ink[channel] - tint.paper[channel]) *
                    (value - paper)) /
                    (ink - paper),
              ),
            ),
          ),
        ),
      )
    : null;
  tintTables.set(contrast, tables);
  return tables;
}

export function pdfDarkPalette(contrast: PDFDarkContrast = "soft") {
  return contrast === "high"
    ? { background: "#000000", foreground: "#ffffff" }
    : { background: "#2f2c2f", foreground: "#dcd7d2" };
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
  const [paper, ink] = lightness[contrast];
  let nextL = paper + (ink - paper) * (1 - l);
  // HSL saturation is unstable near white. Use absolute chroma and a smooth
  // transition so barely tinted antialiasing pixels cannot become bright halos.
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const weight = Math.max(0, Math.min(1, (chroma - 12) / 36));
  nextL += weight * (Math.min(0.87, Math.max(0.64, nextL)) - nextL);
  const rgb = hslToRgb(
    h,
    s * weight,
    contrast === "high" ? nextL : Math.min(ink, Math.max(paper, nextL)),
  );
  const tint = tintChannels(contrast);
  return tint ? rgb.map((value, channel) => tint[channel][value]) : rgb;
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
    xs.push(coordinates[i + 2] + coordinates[i + 4] - coordinates[i]);
    ys.push(coordinates[i + 3] + coordinates[i + 5] - coordinates[i + 1]);
    const x = Math.max(0, Math.min(...xs));
    const y = Math.max(0, Math.min(...ys));
    const right = Math.min(1, Math.max(...xs));
    const bottom = Math.min(1, Math.max(...ys));
    if (right > x && bottom > y)
      regions.push({ x, y, width: right - x, height: bottom - y });
  }
  return regions;
}

/** Adapt neutral background/ink connected to a near-white image border.
 * Colored pixels and isolated neutral interiors keep their original colors.
 * This is a document-background heuristic, not semantic photo segmentation.
 */
function bitmapPaperMask(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  regions: PDFDarkRegion[],
  bitmapMask: Uint8Array,
) {
  const neutral = new Uint8Array(width * height);
  const paper = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let end = 0;
  const white = (pixel: number) => {
    const i = pixel * 4,
      alpha = source[i + 3] / 255;
    const r = source[i] * alpha + 255 * (1 - alpha);
    const g = source[i + 1] * alpha + 255 * (1 - alpha);
    const b = source[i + 2] * alpha + 255 * (1 - alpha);
    return Math.min(r, g, b) >= 235;
  };
  for (let pixel = 0; pixel < neutral.length; pixel++) {
    if (!bitmapMask[pixel]) continue;
    const i = pixel * 4;
    const chroma =
      ((Math.max(source[i], source[i + 1], source[i + 2]) -
        Math.min(source[i], source[i + 1], source[i + 2])) *
        source[i + 3]) /
      255;
    neutral[pixel] = chroma <= 16 ? 1 : 0;
  }
  const visit = (pixel: number) => {
    if (!neutral[pixel] || paper[pixel]) return;
    paper[pixel] = 1;
    queue[end++] = pixel;
  };
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x * width));
    const right = Math.min(width, Math.ceil((region.x + region.width) * width));
    const top = Math.max(0, Math.floor(region.y * height));
    const bottom = Math.min(
      height,
      Math.ceil((region.y + region.height) * height),
    );
    if (right <= left || bottom <= top) continue;
    const seed = (pixel: number) => {
      if (white(pixel)) visit(pixel);
    };
    for (let x = left; x < right; x++) {
      seed(top * width + x);
      seed((bottom - 1) * width + x);
    }
    for (let y = top; y < bottom; y++) {
      seed(y * width + left);
      seed(y * width + right - 1);
    }
  }
  for (let start = 0; start < end; start++) {
    const pixel = queue[start],
      x = pixel % width;
    if (x > 0) visit(pixel - 1);
    if (x + 1 < width) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel + width < paper.length) visit(pixel + width);
  }
  return paper;
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
  const bitmapPaper =
    mode === "adaptive" && bitmapRegions.length
      ? bitmapPaperMask(source, width, height, bitmapRegions, bitmapMask)
      : null;
  // Most paper and text pixels are neutral. Avoid HSL conversion and per-pixel
  // allocations for these, especially on Retina canvases during fast scrolling.
  const [paper, ink] = lightness[contrast];
  const grayscale = Uint8Array.from({ length: 256 }, (_, value) =>
    Math.round((paper + (ink - paper) * (1 - value / 255)) * 255),
  );
  const tint = tintChannels(contrast);
  const [grayR, grayG, grayB] = tint
    ? tint.map((channel) => grayscale.map((value) => channel[value]))
    : [grayscale, grayscale, grayscale];
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4;
    const alpha = source[i + 3] / 255;
    const originalR = Math.round(source[i] * alpha + 255 * (1 - alpha));
    const originalG = Math.round(source[i + 1] * alpha + 255 * (1 - alpha));
    const originalB = Math.round(source[i + 2] * alpha + 255 * (1 - alpha));
    if (bitmapMask[pixel] && !bitmapPaper?.[pixel]) {
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
      output[i] = grayR[originalR];
      output[i + 1] = grayG[originalR];
      output[i + 2] = grayB[originalR];
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
