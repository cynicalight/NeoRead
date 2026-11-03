import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadLibraryArchive } from "./library-archive";

afterEach(() => vi.unstubAllGlobals());

it("replaces the destination only after the complete archive is saved and cleans up failed downloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "neoread-download-test-"));
  try {
    const source = join(root, "library"),
      destination = join(root, "backup.zip");
    await mkdir(source);
    await writeFile(destination, "previous backup");
    const bytes = new TextEncoder().encode("ZIP bytes");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
              },
              pull(controller) {
                controller.error(new Error("connection lost"));
              },
            }),
            { headers: { "Content-Type": "application/zip" } },
          ),
      ),
    );
    await expect(
      downloadLibraryArchive(
        "http://localhost",
        "token",
        {},
        destination,
        source,
        new AbortController().signal,
      ),
    ).rejects.toThrow("connection lost");
    expect(await readFile(destination, "utf8")).toBe("previous backup");
    expect((await readdir(root)).sort()).toEqual(["backup.zip", "library"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes, {
            headers: { "Content-Type": "application/zip" },
          }),
      ),
    );
    await downloadLibraryArchive(
      "http://localhost",
      "token",
      {},
      destination,
      source,
      new AbortController().signal,
    );
    expect(await readFile(destination, "utf8")).toBe("ZIP bytes");
    expect((await readdir(root)).sort()).toEqual(["backup.zip", "library"]);
    await expect(
      downloadLibraryArchive(
        "http://localhost",
        "token",
        {},
        join(source, "backup.zip"),
        source,
        new AbortController().signal,
      ),
    ).rejects.toThrow("书库目录之外");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
