// Adds the Reader ribbon to a macro-enabled template saved by Word for Mac:
//   node apps/cite-plugins/word/add-ribbon.mjs <saved.dotm> [Reader.dotm]
// Word for Mac cannot import VBA modules by script, so import ReaderCite.bas
// in the Visual Basic Editor and save the document as a .dotm first.
// Uses the system zip/unzip (macOS, Linux).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [input, output = join(here, "Reader.dotm")] = process.argv.slice(2);
if (!input) {
  console.error("usage: node add-ribbon.mjs <saved.dotm> [Reader.dotm]");
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "reader-dotm-"));
try {
  execFileSync("unzip", ["-q", resolve(input), "-d", work]);
  const relsPath = join(work, "_rels", ".rels");
  let rels = readFileSync(relsPath, "utf8");
  if (!rels.includes("customUI/customUI14.xml"))
    rels = rels.replace(
      "</Relationships>",
      '<Relationship Id="readerRibbon" Type="http://schemas.microsoft.com/office/2007/relationships/ui/extensibility" Target="customUI/customUI14.xml"/></Relationships>',
    );
  writeFileSync(relsPath, rels);
  cpSync(join(here, "customUI14.xml"), join(work, "customUI", "customUI14.xml"));
  rmSync(resolve(output), { force: true });
  // [Content_Types].xml must stay the first entry.
  execFileSync("zip", ["-q", "-X", resolve(output), "[Content_Types].xml"], { cwd: work });
  execFileSync("zip", ["-q", "-X", "-D", "-r", resolve(output), ".", "-x", "[Content_Types].xml"], { cwd: work });
  console.log(`Built ${resolve(output)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
