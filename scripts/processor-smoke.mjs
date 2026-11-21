// Runs inside the packaged processor directory with Electron's embedded Node.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { model, resolveModel } from "./model.mjs";

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
assert.equal(
  require("@napi-rs/canvas/package.json").version,
  createRequire(join(pdfjsRoot, "package.json"))("@napi-rs/canvas/package.json")
    .version,
);
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const base = dirname(fileURLToPath(import.meta.url));
const task = getDocument({
  data: new Uint8Array(
    await readFile(join(base, "../web/samples/reading-notes.pdf")),
  ),
  standardFontDataUrl: join(pdfjsRoot, "standard_fonts") + "/",
  cMapUrl: join(pdfjsRoot, "cmaps") + "/",
  cMapPacked: true,
  useSystemFonts: false,
});
const pdf = await task.promise;
assert.ok(pdf.numPages > 0);
const page = await pdf.getPage(1);
const viewport = page.getViewport({ scale: 0.5 });
const canvas = createCanvas(
  Math.ceil(viewport.width),
  Math.ceil(viewport.height),
);
await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
assert.ok(canvas.toBuffer("image/png").length > 100);
await task.destroy();

if (process.platform === "darwin") {
  const { createAppleOCR } = await import("./apple-ocr.mjs");
  const scan = createCanvas(1000, 500);
  const context = scan.getContext("2d");
  const ocr = await createAppleOCR();
  try {
    for (const [text, font, y] of [
      ["Readable scanned text", "Helvetica", 140],
      ["人民生活幸福", "PingFang SC", 400],
    ]) {
      context.fillStyle = "white";
      context.fillRect(0, 0, scan.width, scan.height);
      context.fillStyle = "black";
      context.font = `60px "${font}"`;
      context.fillText(text, 100, y);
      const spans = await ocr.recognize(scan);
      const match = spans.find(({ text: actual }) =>
        actual.replaceAll(/\s/g, "").includes(text.replaceAll(/\s/g, "")),
      );
      assert.ok(match, "Packaged Vision OCR did not recognize the sample text");
      const { bounds } = match;
      assert.ok(bounds.x > 0 && bounds.x + bounds.width <= 1);
      assert.ok(bounds.height > 0 && bounds.width > 0);
      assert.ok(bounds.y > y / scan.height - 0.2 && bounds.y < y / scan.height);
      assert.ok(bounds.y + bounds.height <= 1);
    }
  } finally {
    await ocr.close();
  }
} else {
  assert.ok(!(await readdir(base)).includes("apple-ocr-helper"));
}

assert.equal(dirname(await resolveModel()), join(base, "models"));
assert.match(
  await readFile(join(base, "models/LICENSE"), "utf8"),
  /Apache License/,
);
assert.ok(
  (await readFile(join(base, "models/NOTICE.md"), "utf8")).includes(
    model.sha256,
  ),
);
const temporary = await mkdtemp(join(tmpdir(), "neoread-offline-layout-"));
try {
  // Exercise the actual worker with no --model override or library cache.
  // Block both fetch and TCP connections, including accidental download fallback.
  const guard = join(temporary, "offline.mjs");
  await writeFile(
    guard,
    `
import { Socket } from "node:net";
function denyNetwork() { throw new Error("Network access is disabled in the layout smoke"); }
globalThis.fetch = denyNetwork;
Socket.prototype.connect = denyNetwork;
`,
  );
  const output = join(temporary, "output");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(guard).href,
      join(base, "main.mjs"),
      "--input",
      join(base, "../web/samples/reading-notes.pdf"),
      "--output",
      output,
    ],
    {
      cwd: temporary,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /model-download|model-progress/);
  const manifest = JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.pages, pdf.numPages);
  assert.equal(manifest.model.sha256, model.sha256);
  assert.equal(manifest.timings.length, pdf.numPages);
  assert.ok(manifest.timings.every((page) => page.regions > 0));
  assert.ok(manifest.blocks.some((block) => block.text.length > 0));
  assert.ok((await readFile(join(output, "paper.md"), "utf8")).length > 0);
  const corpus = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(guard).href,
      join(base, "corpus.mjs"),
      "--input",
      join(base, "../web/samples/reading-notes.pdf"),
      "--output",
      join(temporary, "corpus.json"),
      "--pages",
      "1",
    ],
    {
      cwd: temporary,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  if (corpus.error) throw corpus.error;
  assert.equal(corpus.status, 0, corpus.stderr);
  const original = JSON.parse(
    await readFile(join(temporary, "corpus.json"), "utf8"),
  );
  assert.equal(original.totalPages, pdf.numPages);
  assert.deepEqual(
    original.pages.map((page) => page.page),
    [1],
  );
  assert.ok(
    original.pages.some((page) => page.spans.some((span) => span.text.trim())),
  );
  const pageImages = join(temporary, "page-images");
  await mkdir(pageImages);
  const requestedPages = pdf.numPages > 1 ? [1, 2] : [1];
  const rendered = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(guard).href,
      join(base, "render-pages.mjs"),
      "--input",
      join(base, "../web/samples/reading-notes.pdf"),
      "--output",
      pageImages,
      "--pages",
      requestedPages.join(","),
    ],
    {
      cwd: temporary,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  if (rendered.error) throw rendered.error;
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.deepEqual(
    (await readdir(pageImages)).sort(),
    requestedPages.map((page) => `page-${page}.png`),
  );
  for (const page of requestedPages) {
    const bytes = await readFile(join(pageImages, `page-${page}.png`));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  }
  assert.deepEqual((await readdir(temporary)).sort(), [
    "corpus.json",
    "offline.mjs",
    "output",
    "page-images",
  ]);
  console.log(
    `Bundled layout model parsed ${manifest.pages} pages offline (${manifest.blocks.length} blocks).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log("Packaged PDF.js, canvas and real layout-model inference passed.");
