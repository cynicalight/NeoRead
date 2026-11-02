import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { woffToSfnt } from "./woff-to-sfnt.mjs";
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

// Offline PDF export embeds this font; ship its redistribution notice.
const cjk = dirname(require.resolve("@fontsource/noto-sans-sc/package.json"));
const exportFonts = new URL(
  "../apps/web/public/pdf-assets/export-fonts/",
  import.meta.url,
);
await mkdir(exportFonts, { recursive: true });
await writeFile(
  new URL("NotoSansSC-Regular.ttf", exportFonts),
  woffToSfnt(
    await readFile(
      join(cjk, "files/noto-sans-sc-chinese-simplified-400-normal.woff"),
    ),
  ),
);
await cp(join(cjk, "LICENSE"), new URL("OFL-NotoSansSC.txt", exportFonts));
