import { expect, it } from "vitest";
import { joinInlineText } from "./inline-math";
import type { TextSpan } from "./layout";

function span(
  text: string,
  x: number,
  baseline: number,
  fontSize: number,
  width: number,
  math = true,
): TextSpan {
  return {
    text,
    baseline,
    fontSize,
    math,
    bounds: { x, y: baseline - fontSize * 0.7, width, height: fontSize },
  };
}

it("keeps nested subscripts and accents on their actual glyphs across wrapped prose", () => {
  // Measurements from the reported paragraph, independent of a local PDF path.
  const spans = [
    span("By maximizing", 108, 357.71, 9.96, 218.81, false),
    span("ℳ", 328.82, 357.71, 9.96, 11.96),
    span("𝒯", 340.78, 359.21, 6.97, 4.52),
    span("s", 345.3, 360.2, 4.98, 3.34),
    span(",", 349.14, 359.21, 6.97, 2.37),
    span("𝒯", 351.5, 359.21, 6.97, 4.52),
    span("t", 356.02, 360.2, 4.98, 2.81),
    span(", each", 359.83, 357.71, 9.96, 22.84, false),
    span("˜", 385.21, 357.57, 9.96, 4.98),
    span("𝐱", 384.68, 357.71, 9.96, 6.05),
    span("s", 390.72, 354.1, 6.97, 3.76),
    span("i", 390.72, 360.31, 6.97, 2.82),
    span("effectively captures certain", 396.99, 357.71, 9.96, 107, false),
    span("semantic", 108, 368.62, 9.96, 35.42, false),
    span("ˆ", 146.44, 368.48, 9.96, 4.98),
    span("𝐱", 145.91, 368.62, 9.96, 6.05),
    span("t", 151.95, 365.01, 6.97, 3.01),
    span("i", 151.95, 371.21, 6.97, 2.82),
    span("from the target image.", 157.95, 368.62, 9.96, 88.36, false),
  ];
  const text = joinInlineText(spans);
  expect(text).toBe(
    "By maximizing $\\mathcal{M}_{\\mathcal{T}_{s},\\mathcal{T}_{t}}$ , each $\\tilde{\\mathbf{x}}_{i}^{s}$ effectively captures certain semantic $\\hat{\\mathbf{x}}_{i}^{t}$ from the target image.",
  );
  expect(text).not.toContain("\\tilde{\\mathcal{M}}");
});

it("uses prose baselines rather than font ascent to order mixed fonts", () => {
  const first = span("first", 0, 10, 10, 20, false),
    second = span("second", 22, 10, 10, 30, false),
    next = span("next line", 0, 21, 10, 40, false);
  second.bounds.y -= 3;
  expect(joinInlineText([next, second, first])).toBe("first second next line");
});
