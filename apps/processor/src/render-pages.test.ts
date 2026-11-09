import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function vectorPDF(pages: number) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
  ];
  for (let i = 0; i < pages; i++) {
    const content = "1 0 0 rg 10 10 30 30 re f";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
  return (
    pdf +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  );
}

it("renders every requested PDF page beyond the former eight-page limit", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const directory = await mkdtemp(join(root, ".render-pages-test-"));
  try {
    const entry = join(directory, "render-pages.mjs");
    await build({
      entryPoints: [join(root, "render-pages.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile: entry,
    });
    const input = join(directory, "ten-pages.pdf"),
      output = join(directory, "images");
    await writeFile(input, vectorPDF(10));
    await mkdir(output);
    const child = spawnSync(
      process.execPath,
      [
        entry,
        "--input",
        input,
        "--output",
        output,
        "--pages",
        "10,9,8,7,6,5,4,3,2,1",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    for (let page = 1; page <= 10; page++) {
      const image = await readFile(join(output, `page-${page}.png`));
      expect(image.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(image.readUInt32BE(16)).toBe(200);
      expect(image.readUInt32BE(20)).toBe(200);
    }
    const invalid = spawnSync(
      process.execPath,
      [entry, "--input", input, "--output", output, "--pages", "11"],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Page outside PDF");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("writes complete rendered PNGs beyond the former per-image and total byte limits", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const directory = await mkdtemp(join(root, ".render-pages-test-"));
  try {
    const entry = join(directory, "render-pages.mjs");
    await build({
      entryPoints: [join(root, "render-pages.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile: entry,
    });
    // A real 4 MP PDF image with incompressible pixels exercises the renderer's
    // emitted PNG bytes, without substituting cached images or canvas outputs.
    const pixels = Buffer.alloc(2000 * 2000 * 3);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
    }
    const content = "q 2000 0 0 2000 0 0 cm /Im0 Do Q";
    const objects = [
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
      Buffer.from(
        "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>",
      ),
      ...Array.from({ length: 4 }, () =>
        Buffer.from(
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 2000] /Resources << /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>",
        ),
      ),
      Buffer.from(
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      ),
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 2000 /Height 2000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
        ),
        pixels,
        Buffer.from("\nendstream"),
      ]),
    ];
    const chunks = [Buffer.from("%PDF-1.4\n")],
      offsets = [0];
    let size = chunks[0].length;
    for (const [index, object] of objects.entries()) {
      offsets.push(size);
      const chunk = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n`),
        object,
        Buffer.from("\nendobj\n"),
      ]);
      chunks.push(chunk);
      size += chunk.length;
    }
    chunks.push(
      Buffer.from(
        `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
          offsets
            .slice(1)
            .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
            .join("") +
          `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
      ),
    );
    const input = join(directory, "image-pages.pdf"),
      output = join(directory, "images");
    await writeFile(input, Buffer.concat(chunks));
    await mkdir(output);
    const child = spawnSync(
      process.execPath,
      [entry, "--input", input, "--output", output, "--pages", "1,2,3,4"],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    let total = 0;
    for (let page = 1; page <= 4; page++) {
      const image = await readFile(join(output, `page-${page}.png`));
      expect(image.readUInt32BE(16)).toBe(2000);
      expect(image.readUInt32BE(20)).toBe(2000);
      expect(image.length).toBeGreaterThan(8 * 1024 * 1024);
      total += image.length;
    }
    expect(total).toBeGreaterThan(32 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);
