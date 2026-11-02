import { afterEach, expect, test } from "vitest";
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeOnnxLibraries } from "./dedupe-onnx.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "neoread-onnx-dedupe-"));
  directories.push(directory);
  return directory;
}
const versioned = "libonnxruntime.1.30.0.dylib";
const loader = "libonnxruntime.1.dylib";

test.skipIf(process.platform === "win32")(
  "keeps both library names readable through a relative link and repeated runs",
  async () => {
    const directory = await fixture();
    await writeFile(join(directory, versioned), "native-library");
    await writeFile(join(directory, loader), "native-library");
    expect(await dedupeOnnxLibraries(directory)).toBe(14);
    expect(await readlink(join(directory, versioned))).toBe(loader);
    expect(await readFile(join(directory, versioned), "utf8")).toBe(
      "native-library",
    );
    expect(await dedupeOnnxLibraries(directory)).toBe(0);
  },
);

test("preserves distinct same-size libraries and unrelated native files", async () => {
  const directory = await fixture();
  await writeFile(join(directory, versioned), "first");
  await writeFile(join(directory, loader), "other");
  await writeFile(join(directory, "onnxruntime_binding.node"), "binding");
  expect(await dedupeOnnxLibraries(directory)).toBe(0);
  expect((await lstat(join(directory, versioned))).isFile()).toBe(true);
  expect(
    await readFile(join(directory, "onnxruntime_binding.node"), "utf8"),
  ).toBe("binding");
});

test.skipIf(process.platform === "win32")(
  "preserves upstream symlinks without introducing a cycle",
  async () => {
    const directory = await fixture();
    await writeFile(join(directory, versioned), "native-library");
    await symlink(versioned, join(directory, loader));
    expect(await dedupeOnnxLibraries(directory)).toBe(0);
    expect(await readFile(join(directory, loader), "utf8")).toBe(
      "native-library",
    );
  },
);
