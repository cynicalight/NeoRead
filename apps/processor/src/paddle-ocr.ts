import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import type { TextSpan } from "./layout";
import { decodePaddleBoxes, type Quad } from "./paddle-ocr-db";

const recognitionHeight = 48;
const recognitionDefaultWidth = 320;
const recognitionMaxWidth = 3200;
const detectorMean = [0.485, 0.456, 0.406];
const detectorStd = [0.229, 0.224, 0.225];
const outputName = "fetch_name_0";
const sessionOptions: ort.InferenceSession.SessionOptions = {
  executionProviders: ["cpu"],
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  logSeverityLevel: 3,
};

// The pinned recognizer YAML ends in a sequence of plain or single-quoted
// scalars. Preserve its order, whitespace and multi-code-point entries exactly.
export function parsePaddleAlphabet(config: string) {
  const lines = config.split(/\r?\n/);
  const marker = lines.indexOf("  character_dict:");
  if (marker < 0 || lines[marker - 1] !== "  name: CTCLabelDecode")
    throw new Error("Invalid Paddle OCR dictionary");
  const alphabet = [""]; // CTC blank is class 0.
  const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  for (let i = marker + 1; i < end; i++) {
    const scalar = /^  - (?:'((?:[^']|'')*)'|([^'"].*))$/u.exec(lines[i]);
    if (!scalar) throw new Error("Invalid Paddle OCR dictionary entry");
    alphabet.push(scalar[1]?.replace(/''/g, "'") ?? scalar[2]);
  }
  alphabet.push(" "); // PaddleX appends the ASCII space after the YAML list.
  return alphabet;
}

export function decodePaddleText(
  scores: Float32Array,
  steps: number,
  alphabet: string[],
) {
  const classes = alphabet.length;
  let previous = 0;
  let text = "";
  let sum = 0;
  let count = 0;
  for (let step = 0; step < steps; step++) {
    const offset = step * classes;
    let best = 0;
    let score = scores[offset];
    for (let i = 1; i < classes; i++) {
      if (scores[offset + i] > score) {
        score = scores[offset + i];
        best = i;
      }
    }
    if (best !== 0 && best !== previous) {
      text += alphabet[best];
      sum += score;
      count++;
    }
    previous = best;
  }
  return count && sum / count >= 0.5 ? text.trim() : "";
}

async function runModel(
  session: ort.InferenceSession,
  input: Float32Array,
  width: number,
  height: number,
) {
  const tensor = new ort.Tensor("float32", input, [1, 3, height, width]);
  try {
    const result = await session.run({ x: tensor }, [outputName]);
    return result[outputName];
  } finally {
    tensor.dispose();
  }
}

async function detectLines(session: ort.InferenceSession, page: Canvas) {
  // The mobile model's DetResizeForTest uses resize_long=960, rounded up
  // to the next stride of 128 on each axis, with no letterbox padding.
  const scale = 960 / Math.max(page.width, page.height);
  const width = Math.max(
    128,
    Math.ceil(Math.floor(page.width * scale) / 128) * 128,
  );
  const height = Math.max(
    128,
    Math.ceil(Math.floor(page.height * scale) / 128) * 128,
  );
  const context = createCanvas(width, height).getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.drawImage(page, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const area = width * height;
  const input = new Float32Array(3 * area);
  for (let channel = 0; channel < 3; channel++) {
    const offset = channel * area;
    const shift = 2 - channel;
    const mean = detectorMean[channel];
    const invStd = 1 / detectorStd[channel];
    for (let i = 0; i < area; i++)
      input[offset + i] = (rgba[4 * i + shift] / 255 - mean) * invStd;
  }
  const output = await runModel(session, input, width, height);
  try {
    if (
      output.type !== "float32" ||
      output.dims.length !== 4 ||
      output.dims[0] !== 1 ||
      output.dims[1] !== 1
    )
      throw new Error("Invalid Paddle OCR detection output");
    const [, , mapHeight, mapWidth] = output.dims;
    const lines = decodePaddleBoxes(
      output.data as Float32Array,
      mapWidth,
      mapHeight,
    );
    const scaleX = page.width / mapWidth;
    const scaleY = page.height / mapHeight;
    for (const line of lines)
      for (const point of line) {
        point.x *= scaleX;
        point.y *= scaleY;
      }
    return lines;
  } finally {
    output.dispose();
  }
}

async function recognizeLine(
  session: ort.InferenceSession,
  page: Canvas,
  line: Quad,
  crop: Canvas,
  alphabet: string[],
) {
  let [tl, tr, , bl] = line;
  let width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  let height = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  // Match Paddle's counterclockwise rotation of tall crops.
  if (height >= 1.5 * width) {
    [tl, tr, bl] = [tr, line[2], tl];
    [width, height] = [height, width];
  }
  // Match the upstream width cap; very long lines are squeezed, not truncated.
  const resizedWidth = Math.min(
    recognitionMaxWidth,
    Math.ceil((recognitionHeight * width) / height),
  );
  const paddedWidth = Math.max(recognitionDefaultWidth, resizedWidth);
  const context = crop.getContext("2d");
  context.save();
  context.beginPath();
  context.rect(0, 0, resizedWidth, recognitionHeight);
  context.clip();
  context.fillStyle = "white";
  context.fillRect(0, 0, resizedWidth, recognitionHeight);
  // DB quads are rectangles in detector space and parallelograms after
  // scaling back to the page. Invert their axes to deskew the source crop.
  const ux = tr.x - tl.x;
  const uy = tr.y - tl.y;
  const vx = bl.x - tl.x;
  const vy = bl.y - tl.y;
  const determinant = ux * vy - uy * vx;
  const a = (resizedWidth * vy) / determinant;
  const b = (-recognitionHeight * uy) / determinant;
  const c = (-resizedWidth * vx) / determinant;
  const d = (recognitionHeight * ux) / determinant;
  context.setTransform(a, b, c, d, -a * tl.x - c * tl.y, -b * tl.x - d * tl.y);
  context.drawImage(page, 0, 0);
  context.restore();

  const rgba = context.getImageData(0, 0, resizedWidth, recognitionHeight).data;
  const area = paddedWidth * recognitionHeight;
  const input = new Float32Array(3 * area); // Right padding is zero in normalized space.
  for (let y = 0; y < recognitionHeight; y++) {
    let pixel = 4 * y * resizedWidth;
    let offset = y * paddedWidth;
    for (let x = 0; x < resizedWidth; x++, offset++, pixel += 4) {
      input[offset] = rgba[pixel + 2] / 127.5 - 1;
      input[offset + area] = rgba[pixel + 1] / 127.5 - 1;
      input[offset + 2 * area] = rgba[pixel] / 127.5 - 1;
    }
  }
  const output = await runModel(session, input, paddedWidth, recognitionHeight);
  try {
    if (
      output.type !== "float32" ||
      output.dims.length !== 3 ||
      output.dims[0] !== 1 ||
      output.dims[2] !== alphabet.length
    )
      throw new Error("Invalid Paddle OCR recognition output");
    return decodePaddleText(
      output.data as Float32Array,
      output.dims[1],
      alphabet,
    );
  } finally {
    output.dispose();
  }
}

export async function createPaddleOCR(directory: string): Promise<{
  recognize(canvas: Canvas): Promise<TextSpan[]>;
  close(): Promise<void>;
}> {
  const alphabet = parsePaddleAlphabet(
    await readFile(join(directory, "rec.yml"), "utf8"),
  );
  if (alphabet.length !== 18385)
    throw new Error("Invalid Paddle OCR dictionary size");
  const detector = await ort.InferenceSession.create(
    join(directory, "det.onnx"),
    sessionOptions,
  );
  try {
    const recognizer = await ort.InferenceSession.create(
      join(directory, "rec.onnx"),
      {
        ...sessionOptions,
        // Line widths vary. Do not retain width-specific allocation patterns
        // or the largest line's buffers for the rest of a long document.
        enableMemPattern: false,
        enableCpuMemArena: false,
      },
    );
    return {
      async recognize(page) {
        if (!page.width || !page.height) return [];
        const lines = await detectLines(detector, page);
        if (!lines.length) return [];
        const crop = createCanvas(recognitionMaxWidth, recognitionHeight);
        const spans: TextSpan[] = [];
        // One line at a time, even on dense pages: the output alone has
        // 18,385 scores per step and can be tens of MB for a wide line.
        for (const line of lines) {
          let left = page.width,
            top = page.height,
            right = 0,
            bottom = 0;
          for (const p of line) {
            left = Math.min(left, p.x);
            top = Math.min(top, p.y);
            right = Math.max(right, p.x);
            bottom = Math.max(bottom, p.y);
          }
          const x = Math.max(0, left) / page.width;
          const y = Math.max(0, top) / page.height;
          const width = Math.min(page.width, right) / page.width - x;
          const height = Math.min(page.height, bottom) / page.height - y;
          if (width <= 0 || height <= 0) continue;
          const text = await recognizeLine(
            recognizer,
            page,
            line,
            crop,
            alphabet,
          );
          if (text) spans.push({ text, bounds: { x, y, width, height } });
        }
        return spans;
      },
      async close() {
        await Promise.all([detector.release(), recognizer.release()]);
      },
    };
  } catch (error) {
    await detector.release();
    throw error;
  }
}
