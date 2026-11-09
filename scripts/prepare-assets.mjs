import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const pdf = dirname(require.resolve("pdfjs-dist/package.json"));
for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
  await mkdir(
    new URL(`../apps/web/public/pdf-assets/${dir}/`, import.meta.url),
    { recursive: true },
  );
  await cp(
    join(pdf, dir),
    new URL(`../apps/web/public/pdf-assets/${dir}/`, import.meta.url),
    { recursive: true },
  );
}

// Remove generated assets from the retired original-layout exporter on upgrades.
await rm(
  new URL("../apps/web/public/pdf-assets/export-fonts/", import.meta.url),
  { recursive: true, force: true },
);
