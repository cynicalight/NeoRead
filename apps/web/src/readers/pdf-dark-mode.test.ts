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

  it.each([
    [255, 0, 0, 255, 69, 71],
    [255, 255, 0, 255, 250, 71],
    [255, 0, 255, 255, 69, 244],
  ])(
    "keeps saturated RGB(%i, %i, %i) from wrapping in graphite",
    (r, g, b, rr, gg, bb) => {
      expect(adaptPDFColor(r, g, b, "soft")).toEqual([rr, gg, bb]);
      const pixels = new Uint8ClampedArray([r, g, b, 255]);
      processPDFPagePixels(pixels, 1, 1, [], [], "adaptive", "soft");
      expect([...pixels]).toEqual([rr, gg, bb, 255]);
    },
  );

  it("maps grayscale content to black and white in high contrast mode", () => {
    expect(adaptPDFColor(255, 255, 255, "high")).toEqual([0, 0, 0]);
    expect(adaptPDFColor(0, 0, 0, "high")).toEqual([255, 255, 255]);
    expect(adaptPDFColor(128, 128, 128, "high")).toEqual([127, 127, 127]);
    expect(pdfDarkPalette("high")).toEqual({
      background: "#000000",
      foreground: "#ffffff",
    });
    expect(pdfDarkPalette("soft")).toEqual({
      background: "#2f2c2f",
      foreground: "#dcd7d2",
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

it("keeps almost-neutral antialiasing pixels close to neutral instead of producing bright halos", () => {
  const neutral = adaptPDFColor(240, 240, 240);
  const edge = adaptPDFColor(242, 238, 238);
  expect(Math.max(...edge) - Math.min(...edge)).toBeLessThan(5);
  expect(Math.abs(edge[0] - neutral[0])).toBeLessThan(8);
});

it("includes the fourth corner of a rotated bitmap", () => {
  expect(
    imageRegions({ coordinates: [0.5, 0.1, 0.3, 0.3, 0.7, 0.3] })[0].height,
  ).toBeCloseTo(0.4);
});

it("adapts connected neutral image backgrounds and ink while preserving colored content", () => {
  const pixels = new Uint8ClampedArray([
    255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255, 240,
    238, 238, 255, 255, 0, 0, 255,
  ]);
  const result = processPDFPagePixels(
    pixels,
    3,
    2,
    [{ x: 0, y: 0, width: 1, height: 1 }],
    [],
    "adaptive",
  );
  expect([...result.slice(0, 3)]).toEqual([47, 44, 47]);
  expect([...result.slice(4, 7)]).toEqual([220, 215, 210]);
  expect([...result.slice(8, 11)]).toEqual([255, 0, 0]);
});

it("leaves neutral areas without a white image border unchanged", () => {
  const pixels = new Uint8ClampedArray([90, 90, 90, 255, 120, 120, 120, 255]);
  expect([
    ...processPDFPagePixels(
      pixels,
      2,
      1,
      [{ x: 0, y: 0, width: 1, height: 1 }],
      [],
      "adaptive",
    ),
  ]).toEqual([90, 90, 90, 255, 120, 120, 120, 255]);
});

it("preserves enclosed colored-image interiors and never floods outside bitmap bounds", () => {
  const pixels = new Uint8ClampedArray([
    255, 255, 255, 255, 255, 0, 0, 255, 100, 100, 100, 255, 255, 255, 255, 255,
  ]);
  const result = processPDFPagePixels(
    pixels,
    4,
    1,
    [{ x: 0, y: 0, width: 0.75, height: 1 }],
    [],
    "adaptive",
  );
  expect([...result.slice(0, 3)]).toEqual([47, 44, 47]);
  expect([...result.slice(8, 11)]).toEqual([100, 100, 100]);
  expect([...result.slice(12, 15)]).toEqual([47, 44, 47]);
});

it("adapts transparent image borders while preserve mode still composites on white", () => {
  const region = [{ x: 0, y: 0, width: 1, height: 1 }];
  for (const [mode, expected] of [
    ["adaptive", [47, 44, 47]],
    ["preserve", [255, 255, 255]],
  ] as const) {
    const result = processPDFPagePixels(
      new Uint8ClampedArray([0, 0, 0, 0]),
      1,
      1,
      region,
      [],
      mode,
    );
    expect([...result]).toEqual([...expected, 255]);
  }
});
