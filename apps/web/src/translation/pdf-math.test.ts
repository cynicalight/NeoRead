import { expect, it } from "vitest";
import { compileFormula } from "./pdf-math";

it("preserves the geometry of subscripts, superscripts, fractions and Greek symbols", () => {
  const h = compileFormula("h");
  const subscript = compileFormula("h_{t-1}");
  const superscript = compileFormula("x^2");
  expect(subscript.width).toBeGreaterThan(h.width);
  expect(subscript.descent).toBeGreaterThan(h.descent);
  expect(subscript.shapes).toHaveLength(4);
  expect(superscript.ascent).toBeGreaterThan(compileFormula("x").ascent);
  const fraction = compileFormula(String.raw`\frac{\alpha}{\beta}`);
  expect(fraction.shapes.some((s) => s.rect)).toBe(true);
  expect(fraction.ascent + fraction.descent).toBeGreaterThan(1);
});

it("refuses malformed or external-content math instead of silently losing symbols", () => {
  for (const tex of [
    "x^{",
    String.raw`\unknowncommand{x}`,
    String.raw`\includegraphics{https://example.com/a.png}`,
    "x".repeat(4097),
  ]) {
    expect(() => compileFormula(tex)).toThrow();
  }
});

it("recovers a fraction command damaged by JSON form-feed decoding", () => {
  const expected = compileFormula(String.raw`\frac{1}{\sqrt{d_k}}`);
  expect(compileFormula("\u000crac{1}{" + String.raw`\sqrt{d_k}}`)).toEqual(
    expected,
  );
  expect(() => compileFormula("\u000crandom{x}")).toThrow();
});
