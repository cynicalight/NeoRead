import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, it } from "vitest";
import { assertSafeLibraryPath, pathsOverlap } from "./library-path-safety";

it.each([
  ["E:\\Apps\\NeoRead", true],
  ["e:\\apps\\NEOREAD\\library", true],
  ["E:\\Apps", true],
  ["E:\\Apps\\NeoRead\\..\\NeoRead\\library", true],
  ["E:\\NeoReadLibrary", false],
  ["E:\\Apps\\NeoReadLibrary", false],
  ["D:\\Apps\\NeoRead", false],
])("checks Windows path boundaries: %s", (library, overlap) => {
  expect(pathsOverlap(library, "E:\\Apps\\NeoRead", win32)).toBe(overlap);
});

it("rejects aliases into the installation before creating a library", async () => {
  const root = await mkdtemp(join(tmpdir(), "neoread-safe-path-"));
  try {
    const installation = join(root, "app");
    await mkdir(installation);
    const alias = join(root, "alias");
    await symlink(installation, alias, "junction");
    await expect(assertSafeLibraryPath(alias, installation)).rejects.toThrow(
      "安装目录",
    );
    await expect(
      assertSafeLibraryPath(join(alias, "library"), installation),
    ).rejects.toThrow("安装目录");
    await expect(assertSafeLibraryPath(root, installation)).rejects.toThrow(
      "安装目录",
    );
    await expect(
      assertSafeLibraryPath(join(root, "app-library"), installation),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
