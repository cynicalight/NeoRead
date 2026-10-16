import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { migratePDFMarks } from "./endnote-pdf";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    report: { type: "string" },
  },
});
if (
  !values.input ||
  !values.output ||
  !values.report ||
  values.input === values.output
)
  throw new Error("Invalid migration paths");
const data = await readFile(values.input);
if (data.length > 512 * 1024 * 1024) throw new Error("PDF exceeds 512 MB");
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const result = await migratePDFMarks(getDocument, new Uint8Array(data));
await writeFile(values.output, result.bytes, { flag: "wx" });
await writeFile(
  values.report,
  JSON.stringify({ marks: result.marks, warnings: result.warnings }),
  { flag: "wx" },
);
