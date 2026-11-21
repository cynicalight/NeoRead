import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import {
  createPaddleOCR,
  decodePaddleText,
  parsePaddleAlphabet,
} from "./paddle-ocr";
import { decodePaddleBoxes } from "./paddle-ocr-db";

it("retains the official YAML dictionary's class order and punctuation", () => {
  const config = [
    "PostProcess:",
    "  name: CTCLabelDecode",
    "  character_dict:",
    "  - 　",
    "  - 中",
    "  - '0'",
    "  - ''''",
    "  - 🇨🇳",
    "",
  ].join("\n");
  expect(parsePaddleAlphabet(config)).toEqual([
    "",
    "　",
    "中",
    "0",
    "'",
    "🇨🇳",
    " ",
  ]);
});

it("collapses repeated CTC classes, but retains letters separated by a blank", () => {
  const alphabet = ["", "中", "B", "o", "k", " "];
  const classes = [1, 1, 0, 5, 0, 2, 3, 3, 0, 3, 4, 0];
  const scores = new Float32Array(classes.length * alphabet.length);
  classes.forEach((id, step) => {
    scores[step * alphabet.length + id] = 0.9;
  });
  expect(decodePaddleText(scores, classes.length, alphabet)).toBe("中 Book");
  expect(decodePaddleText(scores.fill(0.01), classes.length, alphabet)).toBe(
    "",
  );
  scores[1] = 0.4;
  expect(decodePaddleText(scores, classes.length, alphabet)).toBe("");
});

it("scores and expands a DB component while rejecting low-confidence blobs and thin rules", () => {
  const width = 64;
  const height = 56;
  const map = new Float32Array(width * height);
  expect(decodePaddleBoxes(map, width, height)).toEqual([]);
  for (let y = 10; y <= 16; y++) map.fill(0.98, y * width + 8, y * width + 30);
  for (let y = 24; y <= 34; y++) map.fill(0.45, y * width + 8, y * width + 30);
  map.fill(0.99, 42 * width + 8, 42 * width + 62);
  expect(decodePaddleBoxes(map, width, height)).toEqual([
    [
      { x: 4.5, y: 6.5 },
      { x: 32.5, y: 6.5 },
      { x: 32.5, y: 19.5 },
      { x: 4.5, y: 19.5 },
    ],
  ]);
});

it("retains the angle of a skewed text component for deskewing", () => {
  const width = 64;
  const height = 56;
  const map = new Float32Array(width * height);
  for (let x = 10; x < 50; x++)
    for (let y = 6 + Math.floor(x / 3); y < 13 + Math.floor(x / 3); y++)
      map[y * width + x] = 0.98;
  const [line] = decodePaddleBoxes(map, width, height);
  expect(line).toBeDefined();
  const [tl, tr, , bl] = line;
  expect((tr.y - tl.y) / (tr.x - tl.x)).toBeCloseTo(1 / 3, 1);
  expect((bl.y - tl.y) / (bl.x - tl.x)).toBeCloseTo(-3, 1);
});

// Opt-in, like detect.test.ts: supply the three pinned artifacts, never fetch in tests.
const directory = process.env.NEOREAD_TEST_PADDLE_OCR_MODEL_DIR;
it.skipIf(!directory)(
  "recognizes a raster text line with normalized geometry and ignores non-text pages",
  async () => {
    const page = createCanvas(600, 960);
    const context = page.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, page.width, page.height);
    const ocr = await createPaddleOCR(directory!);
    try {
      expect(await ocr.recognize(page)).toEqual([]);
      context.fillStyle = "blue";
      for (let i = 0; i < 4; i++)
        context.fillRect(160 + 70 * i, 455 - 30 * i, 45, 100 + 30 * i);
      expect(await ocr.recognize(page)).toEqual([]);
      context.fillStyle = "black";
      context.font = "32px sans-serif";
      context.fillText("Recognize this line", 100, 300);
      const spans = await ocr.recognize(page);
      const line = spans.find(({ text }) => /recognize this line/i.test(text));
      expect(line).toBeDefined();
      expect(line!.bounds.x).toBeCloseTo(100 / 600, 1);
      expect(line!.bounds.y).toBeCloseTo(280 / 960, 1);
      expect(line!.bounds.width).toBeGreaterThan(0.3);
      expect(line!.bounds.height).toBeLessThan(0.1);
    } finally {
      await ocr.close();
    }
  },
  30_000,
);
