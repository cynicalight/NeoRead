// Fill only pages missing from Reader's existing parsed original text.
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { extractTextSpans } from "./text";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    pages: { type: "string" },
  },
});
if (!values.input || !values.output)
  throw new Error("Usage: --input PDF --output JSON");
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
  const selected =
    values.pages === undefined
      ? undefined
      : new Set(values.pages.split(",").map(Number));
  if (
    selected &&
    [...selected].some(
      (page) => !Number.isInteger(page) || page < 1 || page > pdf.numPages,
    )
  )
    throw new Error("Invalid missing-page range");
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    if (selected && !selected.has(number)) continue;
    const page = await pdf.getPage(number);
    const spans = await extractTextSpans(page);
    // Keep extraction order and geometry; do not invent semantic layout.
    pages.push({ page: number, spans });
    page.cleanup();
  }
  const outline: { title: string; page: number }[] = [];
  const walk = async (items: Awaited<ReturnType<typeof pdf.getOutline>>) => {
    for (const item of items || []) {
      try {
        const dest =
          typeof item.dest === "string"
            ? await pdf.getDestination(item.dest)
            : item.dest;
        if (dest?.length) {
          const index =
            typeof dest[0] === "number"
              ? dest[0]
              : await pdf.getPageIndex(dest[0]);
          outline.push({ title: item.title, page: index + 1 });
        }
      } catch {
        /* An invalid bookmark must not discard extracted text. */
      }
      await walk(item.items);
    }
  };
  await walk(await pdf.getOutline());
  const body = JSON.stringify({ totalPages: pdf.numPages, pages, outline });
  if (Buffer.byteLength(body) > 32 * 1024 * 1024)
    throw new Error("Text corpus exceeds 32 MB");
  await writeFile(values.output, body, { flag: "wx", mode: 0o600 });
} finally {
  await task.destroy();
}
