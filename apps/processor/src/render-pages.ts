import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { renderPage } from "./render-page";

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    pages: { type: "string" },
  },
});
if (!values.input || !values.output || !values.pages)
  throw new Error("Usage: --input PDF --output DIRECTORY --pages 1,3");
const selected = [...new Set(values.pages.split(",").map(Number))];
if (
  !selected.length ||
  selected.length > 8 ||
  selected.some((p) => !Number.isInteger(p) || p < 1)
)
  throw new Error("Invalid pages");
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve("pdfjs-dist/package.json"));
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = await readFile(values.input);
if (data.byteLength > 512 * 1024 * 1024) throw new Error("PDF exceeds 512 MB");
const task = getDocument({
  data: new Uint8Array(data),
  useSystemFonts: true,
  cMapUrl: join(assets, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(assets, "standard_fonts") + "/",
  wasmUrl: join(assets, "wasm") + "/",
});
try {
  const pdf = await task.promise;
  if (selected.some((p) => p > pdf.numPages))
    throw new Error("Page outside PDF");
  let bytes = 0;
  for (const number of selected) {
    const page = await pdf.getPage(number);
    const { canvas } = await renderPage(page);
    const image = canvas.toBuffer("image/png");
    bytes += image.length;
    if (image.length > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
      throw new Error("Rendered images exceed transport limit");
    await writeFile(join(values.output, `page-${number}.png`), image, {
      flag: "wx",
      mode: 0o600,
    });
    canvas.width = canvas.height = 1;
    page.cleanup();
  }
} finally {
  await task.destroy();
}
