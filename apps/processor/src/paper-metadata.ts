import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } } });
if (!values.input || !values.output) throw new Error("Missing input or output");
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve("pdfjs-dist/package.json"));
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = await readFile(values.input);
if (data.byteLength > 512 * 1024 * 1024) throw new Error("PDF too large");
const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, cMapUrl: join(assets, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(assets, "standard_fonts") + "/", wasmUrl: join(assets, "wasm") + "/" });
try {
  const pdf = await task.promise;
  const metadata = await pdf.getMetadata();
  const pages: string[] = [];
  for (let n = 1; n <= Math.min(2, pdf.numPages); n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").slice(0, 12000));
    page.cleanup();
  }
  await writeFile(values.output, JSON.stringify({ metadata: metadata.info, pages }), { flag: "wx", mode: 0o600 });
} finally { await task.destroy(); }
