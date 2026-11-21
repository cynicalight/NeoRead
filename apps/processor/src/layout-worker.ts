import { stage } from "./diagnostics";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import * as ort from "onnxruntime-node";
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { detectRegions } from "./detect";
import { readingRegions, isAsset, type ReadingRegion } from "./layout";
import { extractTextSpans } from "./text";
import { digest, model, resolveModel } from "./model";
import { renderPage } from "./render-page";
import { addScanText, hasScanImage, missingScanText } from "./scan-page";
import type { TextSpan } from "./layout";
import type { Canvas } from "@napi-rs/canvas";
import { createAppleOCR } from "./apple-ocr";
import { createPaddleOCR } from "./paddle-ocr";

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
stage("pdfjs_load");
const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve("pdfjs-dist/package.json"));
const pdfRequire = createRequire(require.resolve("pdfjs-dist/package.json"));
if (
  pdfRequire.resolve("@napi-rs/canvas") !== require.resolve("@napi-rs/canvas")
)
  throw new Error("PDF.js 和处理器的原生 Canvas 版本必须一致，请重新安装依赖");
stage("arguments");
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    model: { type: "string" },
    // The probe only reports evidence; it never performs OCR or writes output.
    "scan-only": { type: "boolean", default: false },
    // Books parse one chapter at a time; omitted bounds cover the document.
    "from-page": { type: "string" },
    "to-page": { type: "string" },
    debug: { type: "boolean", default: false },
  },
});
const probe = values["scan-only"];
if (!values.input || (!probe && !values.output))
  throw new Error(
    "Usage: --input PDF --output DIRECTORY [--from-page N] [--to-page N] [--model FILE] [--debug]",
  );
const pageBound = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) throw new Error("页码无效");
  return page;
};
const fromPage = pageBound(values["from-page"]),
  toPage = pageBound(values["to-page"]);
const input = resolve(values.input),
  output = resolve(values.output ?? ".");
if (!probe) {
  stage("output_prepare");
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await readdir(output)).length)
    throw new Error("输出目录必须为空，避免覆盖已有解析稿或用户修订");
  await mkdir(join(output, "assets"), { recursive: true, mode: 0o700 });
}
stage("model_verify");
const modelPath = await resolveModel(values.model && resolve(values.model));
// Native initialization logs are classified by the parent into fixed diagnostic
// codes. Raw ONNX messages (which may contain paths) are never persisted.
ort.env.logLevel = "verbose";
stage("session_create", 0, ort.env.versions.node ?? "");
const session = await ort.InferenceSession.create(modelPath, {
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  executionProviders: ["cpu"],
  logSeverityLevel: 0,
  logVerbosityLevel: 1,
});
stage("pdf_read");
const file = await readFile(input);
if (file.byteLength > 512 * 1024 * 1024) throw new Error("PDF 超过 512 MB");
stage("pdf_open");
const loading = getDocument({
  data: new Uint8Array(file),
  useSystemFonts: true,
  cMapUrl: join(assets, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(assets, "standard_fonts") + "/",
  wasmUrl: join(assets, "wasm") + "/",
});
interface Block extends ReadingRegion {
  id: string;
  page: number;
  image?: string;
}
const blocks: Block[] = [];
const warnings: string[] = [];
const sections: string[] = [];
const timings: {
  page: number;
  milliseconds: number;
  regions: number;
  assets: number;
}[] = [];
const engine = process.env.NEOREAD_OCR_ENGINE;
let recognizer:
  | { recognize(canvas: Canvas): Promise<TextSpan[]>; close(): Promise<void> }
  | undefined;
let notified = false;
const start = performance.now();
async function processPages() {
  const pdf = await loading.promise;
  const first = fromPage ?? 1,
    last = Math.min(toPage ?? pdf.numPages, pdf.numPages);
  if (first > last) throw new Error("页码范围无效");
  stage("pdf_metadata");
  const metadata = await pdf.getMetadata();
  // Old, textless manifests have no scan evidence. Probe the front matter
  // and interior without rewriting the user's existing manifest or notes.
  const step = probe ? Math.max(1, Math.floor((last - first) / 7)) : 1;
  for (
    let number = first, sampled = 0;
    number <= last && (!probe || sampled < 8);
    number += step, sampled++
  ) {
    const pageStart = performance.now();
    stage("page_load", number);
    const page = await pdf.getPage(number);
    stage("page_render", number);
    const { canvas, scale } = await renderPage(page);
    const context = canvas.getContext("2d");
    stage("page_inference", number);
    const regions = await detectRegions(session, canvas);
    stage("page_text", number);
    let spans = await extractTextSpans(page, scale);
    const [x0, y0, x1, y1] = page.view;
    const scanned =
      missingScanText(regions, spans) &&
      hasScanImage(await page.getOperatorList(), OPS, (x1 - x0) * (y1 - y0));
    if (scanned && !notified) {
      process.stdout.write(
        JSON.stringify({ event: "scan", page: number, total: pdf.numPages }) +
          "\n",
      );
      notified = true;
    }
    if (probe) {
      page.cleanup();
      if (scanned) break;
      continue;
    }
    let recognized = false;
    let ocrSpans: ReadonlySet<TextSpan> | undefined;
    if (scanned && (engine === "system" || engine === "paddle")) {
      stage("page_ocr", number);
      if (!recognizer) {
        if (engine === "system") {
          recognizer = await createAppleOCR();
        } else {
          const directory = process.env.NEOREAD_OCR_MODEL_DIR;
          if (!directory) throw new Error("未配置本地 OCR 模型目录");
          recognizer = await createPaddleOCR(directory);
        }
      }
      const pixels =
        Math.max(canvas.width, canvas.height) < 1800
          ? (await renderPage(page, 2000)).canvas
          : canvas;
      const lines = await recognizer.recognize(pixels);
      recognized = lines.length > 0;
      const merged = addScanText(spans, lines);
      spans = merged.spans;
      ocrSpans = merged.ocrSpans;
    }
    const { blocks: composed, unmatched } = readingRegions(
      regions,
      spans,
      ocrSpans,
    );
    const pageBlocks: Block[] = composed.map((region, i) => ({
      ...region,
      ...(recognized && region.text
        ? {
            ocr: true,
            text: region.text.replace(
              /(\p{Script=Han}) +(?=\p{Script=Han})/gu,
              "$1",
            ),
          }
        : {}),
      id: `p${number}-b${i + 1}`,
      page: number,
    }));
    stage("page_output", number);
    for (const block of pageBlocks) {
      if (!isAsset(block.label)) continue;
      const b = block.bounds;
      const x = Math.max(0, Math.floor(b.x * canvas.width) - 3),
        y = Math.max(0, Math.floor(b.y * canvas.height) - 3);
      const width = Math.min(
        canvas.width - x,
        Math.ceil(b.width * canvas.width) + 6,
      );
      const height = Math.min(
        canvas.height - y,
        Math.ceil(b.height * canvas.height) + 6,
      );
      const crop = createCanvas(width, height);
      crop
        .getContext("2d")
        .drawImage(canvas, x, y, width, height, 0, 0, width, height);
      block.image = `assets/${block.id}.png`;
      await writeFile(join(output, block.image), crop.toBuffer("image/png"), {
        mode: 0o600,
      });
    }
    blocks.push(...pageBlocks);
    sections.push(`<!-- page:${number} -->`);
    for (const block of pageBlocks) {
      if (block.image)
        sections.push(
          `<!-- block:${block.id} type:${block.label} -->\n[${block.label}: ${block.id}](${block.image})`,
        );
      else if (block.text)
        sections.push(
          `<!-- block:${block.id} -->\n${block.label === "doc_title" ? "# " : block.label === "paragraph_title" ? "## " : ""}${block.text}`,
        );
    }
    if (unmatched) {
      sections.push(`<!-- unmatched-text page:${number} -->\n${unmatched}`);
      warnings.push(`第 ${number} 页有未归入版面块的文字，已保留。`);
    }
    if (values.debug) {
      await writeFile(
        join(output, `page-${number}.png`),
        canvas.toBuffer("image/png"),
        { mode: 0o600 },
      );
      context.lineWidth = 2;
      context.font = "16px sans-serif";
      for (const block of pageBlocks) {
        const b = block.bounds;
        context.strokeStyle = isAsset(block.label) ? "#e11d48" : "#2563eb";
        context.strokeRect(
          b.x * canvas.width,
          b.y * canvas.height,
          b.width * canvas.width,
          b.height * canvas.height,
        );
        context.fillStyle = context.strokeStyle;
        context.fillText(
          `${block.id} ${block.label} ${block.confidence.toFixed(2)}`,
          b.x * canvas.width,
          Math.max(16, b.y * canvas.height),
        );
      }
      await writeFile(
        join(output, `layout-${number}.png`),
        canvas.toBuffer("image/png"),
        { mode: 0o600 },
      );
    }
    timings.push({
      page: number,
      milliseconds: Math.round(performance.now() - pageStart),
      regions: regions.length,
      assets: pageBlocks.filter((b) => b.image).length,
    });
    process.stdout.write(
      JSON.stringify({
        event: "page",
        ...timings.at(-1),
        total: pdf.numPages,
      }) + "\n",
    );
    page.cleanup();
  }
  if (probe) return;
  stage("manifest_write");
  const manifest = {
    schemaVersion: 1,
    scanDetectionVersion: 1,
    textExtractionVersion: 2,
    inputSHA256: await digest(input),
    model,
    pages: pdf.numPages,
    // Present only for a page range; a full parse covers every page.
    ...(fromPage || toPage
      ? {
          parsedPages: Array.from(
            { length: last - first + 1 },
            (_, i) => first + i,
          ),
        }
      : {}),
    metadata: metadata.info,
    blocks,
    warnings,
    incompletePages: [],
    timings,
    elapsedMilliseconds: Math.round(performance.now() - start),
    peakRSSBytes: process.resourceUsage().maxRSS * 1024,
  };
  await writeFile(join(output, "paper.md"), sections.join("\n\n") + "\n", {
    mode: 0o600,
  });
  await writeFile(
    join(output, "manifest.json.part"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  await rename(
    join(output, "manifest.json.part"),
    join(output, "manifest.json"),
  );
  process.stdout.write(
    JSON.stringify({
      event: "done",
      pages: pdf.numPages,
      assets: blocks.filter((b) => b.image).length,
      elapsedMilliseconds: manifest.elapsedMilliseconds,
      peakRSSBytes: manifest.peakRSSBytes,
    }) + "\n",
  );
}
try {
  await processPages();
} finally {
  await recognizer?.close();
  await loading.destroy();
  await session.release();
}
