import { describe, expect, it } from "vitest";
import { adaptPDFColor, pdfDarkPalette } from "./pdf-dark-mode";

describe("PDF dark appearance colors", () => {
  it("maps white paper dark and black ink to soft gray", () => {
    const paper = adaptPDFColor(255, 255, 255);
    const ink = adaptPDFColor(0, 0, 0);
    expect(paper[0]).toBeLessThan(50);
    expect(ink[0]).toBeGreaterThan(200);
    expect(ink[0]).toBeLessThan(240);
  });

  it("keeps distinct hues while brightening colored text", () => {
    const red = adaptPDFColor(190, 20, 35);
    const blue = adaptPDFColor(20, 60, 190);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(red).not.toEqual(blue);
  });

  it("maps grayscale content to black and white in high contrast mode", () => {
    expect(adaptPDFColor(255, 255, 255, "high")).toEqual([0, 0, 0]);
    expect(adaptPDFColor(0, 0, 0, "high")).toEqual([255, 255, 255]);
    expect(adaptPDFColor(128, 128, 128, "high")).toEqual([127, 127, 127]);
    expect(pdfDarkPalette("high")).toEqual({
      background: "#000000",
      foreground: "#ffffff",
    });
    expect(pdfDarkPalette("soft")).toEqual({
      background: "#242424",
      foreground: "#dedede",
    });
  });
});

it("keeps almost-neutral antialiasing pixels close to neutral instead of producing bright halos", () => {
  const neutral = adaptPDFColor(240, 240, 240);
  const edge = adaptPDFColor(242, 238, 238);
  expect(Math.max(...edge) - Math.min(...edge)).toBeLessThan(5);
  expect(Math.abs(edge[0] - neutral[0])).toBeLessThan(8);
});
