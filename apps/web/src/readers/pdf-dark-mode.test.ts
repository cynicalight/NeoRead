import { describe, expect, it } from "vitest";
import {
  adaptPDFColor,
  cropPDFRegions,
  imageRegions,
  pdfDarkPalette,
  processPDFPagePixels,
} from "./pdf-dark-mode";

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

  it("keeps the grayscale fast path identical to the color mapping, including antialiasing", () => {
    for (const contrast of ["high", "soft"] as const) {
      const pixels = Uint8ClampedArray.from(
        Array.from({ length: 256 }, (_, value) => [
          value,
          value,
          value,
          255,
        ]).flat(),
      );
      processPDFPagePixels(pixels, 256, 1, [], [], "adaptive", contrast);
      for (let value = 0; value < 256; value++)
        expect([...pixels.slice(value * 4, value * 4 + 3)]).toEqual(
          adaptPDFColor(value, value, value, contrast),
        );
    }
  });

  it("preserves bitmap pixels and restores vector figure pixels in preserve mode", () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255,
    ]);
    const result = processPDFPagePixels(
      source,
      3,
      1,
      [{ x: 0, y: 0, width: 1 / 3, height: 1 }],
      [{ x: 1 / 3, y: 0, width: 1 / 3, height: 1 }],
      "preserve",
    );
    expect([...result.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...result.slice(4, 8)]).toEqual([0, 0, 0, 255]);
    expect([...result.slice(8, 12)]).not.toEqual([255, 0, 0, 255]);
  });

  it("adapts vector figures while keeping bitmap colors in adaptive mode", () => {
    const result = processPDFPagePixels(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255]),
      2,
      1,
      [{ x: 0, y: 0, width: 0.5, height: 1 }],
      [{ x: 0.5, y: 0, width: 0.5, height: 1 }],
      "adaptive",
    );
    expect([...result.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...result.slice(4, 8)]).not.toEqual([0, 0, 0, 255]);
  });

  it("inverts figures and bitmaps while adapting body text", () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255, 10, 20, 30, 255, 0, 0, 0, 255,
    ]);
    const result = processPDFPagePixels(
      source,
      3,
      1,
      [{ x: 0, y: 0, width: 1 / 3, height: 1 }],
      [{ x: 1 / 3, y: 0, width: 1 / 3, height: 1 }],
      "invert",
    );
    expect([...result.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...result.slice(4, 8)]).toEqual([245, 235, 225, 255]);
    expect([...result.slice(8, 12)]).not.toEqual([0, 0, 0, 255]);
  });

  it("fills transparent paper pixels instead of letting them inherit the page", () => {
    const result = processPDFPagePixels(
      new Uint8ClampedArray([0, 0, 0, 0]),
      1,
      1,
      [],
      [],
      "preserve",
    );
    expect(result[3]).toBe(255);
    expect(result[0]).toBeLessThan(50);
  });

  it("converts normalized PDF.js image corners into image bounds", () => {
    const [region] = imageRegions({
      coordinates: [0.1, 0.2, 0.5, 0.2, 0.1, 0.8],
    });
    expect(region?.x).toBeCloseTo(0.1);
    expect(region?.y).toBeCloseTo(0.2);
    expect(region?.width).toBeCloseTo(0.4);
    expect(region?.height).toBeCloseTo(0.6);
  });

  it("clips figure masks to the currently rendered high-resolution region", () => {
    const [region] = cropPDFRegions(
      [{ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }],
      { x: 0.4, y: 0.1, width: 0.4, height: 0.6 },
    );
    expect(region?.x).toBeCloseTo(0);
    expect(region?.y).toBeCloseTo(1 / 6);
    expect(region?.width).toBeCloseTo(0.5);
    expect(region?.height).toBeCloseTo(2 / 3);
  });
});
