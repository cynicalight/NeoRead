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
  // HSL saturation is unstable near white. Use absolute chroma and a smooth
  // transition so barely tinted antialiasing pixels cannot become bright halos.
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const weight = Math.max(0, Math.min(1, (chroma - 12) / 36));
  nextL += weight * (Math.min(0.87, Math.max(0.64, nextL)) - nextL);
  return hslToRgb(
    h,
    s * weight,
    contrast === "high" ? nextL : Math.min(0.87, Math.max(0.14, nextL)),
  );
}
