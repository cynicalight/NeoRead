import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("built entry captures native loader failure before worker evaluation", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const directory = await mkdtemp(join(root, ".bootstrap-test-"));
  try {
    const broken = join(directory, "broken.mjs");
    await writeFile(
      broken,
      'throw Object.assign(new Error("PRIVATE document C:/Users/private/file.pdf"), { code: "ERR_DLOPEN_FAILED" });',
    );
    await build({
      entryPoints: [join(root, "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      splitting: true,
      outdir: join(directory, "dist"),
      outExtension: { ".js": ".mjs" },
      plugins: [
        {
          name: "native-failure",
          setup(builder) {
            builder.onResolve({ filter: /^onnxruntime-node$/ }, () => ({
              path: broken,
              external: true,
            }));
          },
        },
      ],
    });
    const child = spawnSync(
      process.execPath,
      [join(directory, "dist/main.mjs")],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const events = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      stage: "onnx_load",
      status: "failed",
      errorCode: "ERR_DLOPEN_FAILED",
    });
    expect(child.stdout + child.stderr).not.toMatch(/PRIVATE|Users\/private/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
