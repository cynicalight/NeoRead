import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  drawObject,
  concatTransformationMatrix,
  pushGraphicsState,
  popGraphicsState,
  setGraphicsState,
  setFillingRgbColor,
  rectangle,
  fill,
} from "pdf-lib";
import { defaultTheme } from "@neoread/core";
import { pdfObjectColors, type PDFObjectColors } from "./pdf-dark-mode";
import { pdfCropOperations } from "./pdf-crop-operations";

const require = createRequire(
  new URL("../../../processor/package.json", import.meta.url),
);
const { createCanvas } = require("@napi-rs/canvas");

async function fixture(colors: PDFObjectColors | null) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([160, 100]);
  const color = (hex: string) => {
    const value = colors?.mapColor(hex) ?? hex;
    return rgb(
      ...([1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ]),
    );
  };
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 160,
    height: 100,
    color: color("#ffffff"),
  });
  page.drawRectangle({
    x: 4,
    y: 4,
    width: 18,
    height: 20,
    color: color("#000000"),
  });
  page.drawRectangle({
    x: 25,
    y: 4,
    width: 18,
    height: 20,
    color: color("#808080"),
    opacity: 0.5,
  });
  page.drawLine({
    start: { x: 4, y: 28 },
    end: { x: 70, y: 28 },
    thickness: 0.7,
    color: color("#000000"),
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Sharp PDF 123", {
    x: 4,
    y: 60,
    size: 14,
    font,
    color: color("#000000"),
  });
  page.drawText("colored", {
    x: 4,
    y: 40,
    size: 12,
    font,
    color: color("#204080"),
  });
  const image = createCanvas(10, 10);
  const ctx = image.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 10, 10);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 5, 10);
  const png = await doc.embedPng(image.toBuffer("image/png"));
  page.drawImage(png, { x: 100, y: 50, width: 40, height: 40 });

  // A luminosity mask is data, not page artwork: white must stay opaque.
  const mask = doc.context.register(
    doc.context.flateStream("1 g 0 0 10 10 re f 0 g 10 0 10 10 re f", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 20, 10],
      Resources: {},
      Group: { S: "Transparency", CS: "DeviceGray", I: true },
    }),
  );
  const state = doc.context.register(
    doc.context.obj({ Type: "ExtGState", SMask: { S: "Luminosity", G: mask } }),
  );
  page.node.setExtGState(PDFName.of("TestMask"), state);
  const ink = color("#000000");
  page.pushOperators(
    pushGraphicsState(),
    setGraphicsState("TestMask"),
    setFillingRgbColor(ink.red, ink.green, ink.blue),
    rectangle(0, 0, 20, 10),
    fill(),
    popGraphicsState(),
  );
  // Stencil images are glyph/vector-like masks painted in the current ink,
  // unlike ordinary RGB images. Their cached tinted surface must use target ink.
  const stencil = doc.context.register(
    doc.context.flateStream(
      new Uint8Array([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]),
      {
        Type: "XObject",
        Subtype: "Image",
        Width: 8,
        Height: 8,
        ImageMask: true,
        BitsPerComponent: 1,
        Decode: [0, 1],
      },
    ),
  );
  page.node.setXObject(PDFName.of("Stencil"), stencil);
  page.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(ink.red, ink.green, ink.blue),
    concatTransformationMatrix(20, 0, 0, 20, 120, 10),
    drawObject("Stencil"),
    popGraphicsState(),
  );
  return doc.save();
}

async function render(
  data: Uint8Array,
  scale: number,
  pageColors?: PDFObjectColors,
) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas,
      canvasContext: canvas.getContext("2d"),
      viewport,
      pageColors,
    }).promise;
    return canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height)
      .data as Uint8ClampedArray;
  } finally {
    await task.destroy();
  }
}

it("renders the same high-resolution crop pixels while skipping unrelated PDF operations", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: await fixture(null),
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise,
      page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const preview = createCanvas(Math.ceil(base.width), Math.ceil(base.height));
    await page.render({
      canvas: preview,
      canvasContext: preview.getContext("2d"),
      viewport: base,
      recordOperations: true,
    }).promise;
    const bounds = { x: 0, y: 0, width: 0.5, height: 0.7 };
    const filter = pdfCropOperations(page, bounds)!;
    const operations = await page.getOperatorList();
    expect(operations.fnArray.some((_, index) => !filter(index))).toBe(true);
    const viewport = page.getViewport({ scale: 6 });
    const crop = async (filtered: boolean) => {
      const canvas = createCanvas(
        Math.ceil(viewport.width * bounds.width),
        Math.ceil(viewport.height * bounds.height),
      );
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: [
          1,
          0,
          0,
          1,
          -viewport.width * bounds.x,
          -viewport.height * bounds.y,
        ],
        operationsFilter: filtered ? filter : undefined,
      }).promise;
      return canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
    };
    expect(await crop(true)).toEqual(await crop(false));
  } finally {
    await task.destroy();
  }
});

async function stateFixture(colors: PDFObjectColors | null) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([160, 100]);
  const components = (hex: string) => {
    const mapped = colors?.mapColor(hex) ?? hex;
    return [1, 3, 5]
      .map((offset) => parseInt(mapped.slice(offset, offset + 2), 16) / 255)
      .join(" ");
  };
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.setFontDictionary(PDFName.of("Body"), font.ref);
  const glyph = doc.context.register(
    doc.context.flateStream("1000 0 d0 0 0 800 800 re f"),
  );
  const stencil = doc.context.register(
    doc.context.flateStream(
      new Uint8Array([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]),
      {
        Type: "XObject",
        Subtype: "Image",
        Width: 8,
        Height: 8,
        ImageMask: true,
        BitsPerComponent: 1,
        Decode: [0, 1],
      },
    ),
  );
  // A Type3 stencil can be compiled into rawFillPath. The glyph's own color
  // setter must not overwrite target ink after the outer showText call.
  const stencilGlyph = doc.context.register(
    doc.context.flateStream(
      `1000 0 d0 ${components("#204080")} rg 800 0 0 800 0 0 cm /Bit Do`,
    ),
  );
  const type3 = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "Type3",
      FontBBox: [0, 0, 1000, 1000],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { A: glyph, B: stencilGlyph },
      Encoding: { Type: "Encoding", Differences: [65, "A", "B"] },
      FirstChar: 65,
      LastChar: 66,
      Widths: [1000, 1000],
      Resources: { XObject: { Bit: stencil } },
    }),
  );
  page.node.setFontDictionary(PDFName.of("Glyph"), type3);
  const group = doc.context.register(
    doc.context.flateStream(
      `0 0 12 12 re f q ${components("#204080")} rg 14 0 12 12 re f Q 28 0 12 12 re f`,
      {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 40, 12],
        Resources: {},
        Group: { S: "Transparency", CS: "DeviceRGB", I: true },
      },
    ),
  );
  page.node.setXObject(PDFName.of("Group"), group);
  page.node.addContentStream(
    doc.context.register(
      doc.context.flateStream(`
q ${components("#ffffff")} rg 0 0 160 100 re f Q
${colors ? `${components("#000000")} rg ${components("#000000")} RG` : ""}
4 4 10 10 re f 18 4 10 10 re S
q ${components("#204080")} rg 4 20 10 10 re f
q ${components("#804020")} rg 18 20 10 10 re f Q
32 20 10 10 re f Q 46 20 10 10 re f
q ${components("#804020")} rg 1 0 0 1 65 5 cm /Group Do Q
q ${components("#204080")} rg BT /Glyph 18 Tf 5 45 Td (AB) Tj ET Q
q ${components("#804020")} rg ${components("#204080")} RG
BT /Body 15 Tf 1 Tr 1 w 45 45 Td (stroke) Tj ET
BT /Body 15 Tf 2 Tr 1 w 45 65 Td (both) Tj ET Q
4 80 10 10 re f
`),
    ),
  );
  return doc.save();
}

it.each(["soft", "high"] as const)(
  "%s keeps source colors across restore, groups, Type3 and stroked glyphs",
  async (contrast) => {
    const colors = pdfObjectColors({
      ...defaultTheme,
      mode: "dark",
      pdfDarkContrast: contrast,
    })!;
    const source = await stateFixture(null);
    const reference = await stateFixture(colors);
    for (const scale of [1, 1.75, 3]) {
      const actual = await render(source.slice(), scale, colors);
      const expected = await render(reference.slice(), scale);
      let difference = 0;
      for (let i = 0; i < actual.length; i++) {
        difference = Math.max(difference, Math.abs(actual[i] - expected[i]));
      }
      expect(difference).toBeLessThanOrEqual(1);
    }
  },
);

it("reuses mapped ink across repeated paints and non-paint instructions", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([160, 100]);
  for (let i = 0; i < 200; i++) {
    page.drawRectangle({
      x: i % 150,
      y: i % 90,
      width: 2,
      height: 2,
      color: rgb(0, 0, 0),
    });
  }
  const palette = pdfObjectColors({ ...defaultTheme, mode: "dark" })!;
  const mapColor = vi.fn(palette.mapColor);
  await render(await doc.save(), 1, { ...palette, mapColor });
  expect(mapColor).toHaveBeenCalledTimes(1);
  expect(mapColor).toHaveBeenCalledWith("#000000");
});

it.each(["soft", "high"] as const)(
  "%s renders vectors and glyphs directly in target colors, preserving images and masks",
  async (contrast) => {
    const colors = pdfObjectColors({
      ...defaultTheme,
      mode: "dark",
      pdfDarkContrast: contrast,
    })!;
    const original = await fixture(null);
    const reference = await fixture(colors);
    // Multiple non-integer scales exercise glyph antialiasing without a second
    // raster recoloring pass. Compare against a PDF authored in the target colors.
    for (const scale of [1, 1.75, 3]) {
      const actual = await render(original.slice(), scale, colors);
      const expected = await render(reference.slice(), scale);
      expect(actual.length).toBe(expected.length);
      let maxDifference = 0;
      for (let i = 0; i < actual.length; i++)
        maxDifference = Math.max(
          maxDifference,
          Math.abs(actual[i] - expected[i]),
        );
      expect(maxDifference).toBeLessThanOrEqual(1);
    }
  },
  30_000,
);
