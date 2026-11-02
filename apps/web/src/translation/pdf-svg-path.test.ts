import { expect, it } from "vitest";
import { cubicGlyphPath } from "./pdf-svg-path";
import { compileFormula } from "./pdf-math";

it("preserves quadratic geometry and reflects each successive smooth control point", () => {
  expect(cubicGlyphPath("M0 0 Q3 6 6 0 T12 0 T18 0")).toBe(
    "M0 0 C2 4 4 4 6 0 C8 -4 10 -4 12 0 C14 4 16 4 18 0",
  );
  expect(cubicGlyphPath("m0 0 q3 6 6 0 t6 0 t6 0")).toBe(
    cubicGlyphPath("M0 0 Q3 6 6 0 T12 0 T18 0"),
  );
  expect(cubicGlyphPath("M0 0 Q3 6 6 0 L9 0 T15 0")).toBe(
    "M0 0 C2 4 4 4 6 0 L9 0 C9 0 11 0 15 0",
  );
});

it("keeps repeated coordinates and independent subpaths well defined", () => {
  expect(cubicGlyphPath("M0 0 3 3 h2 v-1 z m2 0 l3 1")).toBe(
    "M0 0 L3 3 L5 3 L5 2 Z M2 0 L5 1",
  );
  expect(cubicGlyphPath("M0 0 C1 2 2 2 3 0 S5 -2 6 0")).toBe(
    "M0 0 C1 2 2 2 3 0 C4 -2 5 -2 6 0",
  );
  for (const path of ["M0", "M0 0 Q1 2", "M0 0 A1 1 0 0 1 2 2", "M0 0#"])
    expect(() => cubicGlyphPath(path)).toThrow();
});

it("normalizes real parentheses and other mathematical glyphs before PDF writing", () => {
  for (const tex of [
    "(x_1,\\ldots,x_n)",
    "[z]",
    String.raw`\sqrt{x^2}`,
    String.raw`\frac{1}{1+x}`,
  ]) {
    const formula = compileFormula(tex);
    expect(formula.shapes.length).toBeGreaterThan(0);
    for (const shape of formula.shapes)
      if (shape.path) expect(shape.path).not.toMatch(/[QqTtSs]/);
  }
});
