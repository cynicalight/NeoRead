import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryCatalog } from "./library-catalog";

it("keeps the original library, remembers imports across launches and disambiguates names", async () => {
  const root = await mkdtemp(join(tmpdir(), "neoread-catalog-"));
  try {
    const original = join(root, "library");
    await mkdir(original);
    await writeFile(join(original, "neoread.sqlite"), "original");
    const catalog = new LibraryCatalog(root);
    const first = await catalog.list(original);
    expect(first.libraries).toHaveLength(1);
    expect(first.libraries[0].name).toBe("论文库");
    expect(catalog.cachedName(original)).toBe("论文库");
    const incoming = await catalog.allocate(original, "论文库");
    expect(incoming.name).toBe("论文库(1)");
    await mkdir(incoming.directory);
    await writeFile(join(incoming.directory, "neoread.sqlite"), "incoming");
    await catalog.remember(incoming);
    const reopened = new LibraryCatalog(root);
    expect((await reopened.list(incoming.directory)).activeId).toBe(
      incoming.id,
    );
    expect((await reopened.list(original)).activeId).toBe(first.activeId);
    expect((await reopened.allocate(incoming.directory, "论文库")).name).toBe(
      "论文库(2)",
    );
    const renamed = await reopened.rename(
      incoming.directory,
      incoming.id,
      "论文库",
    );
    expect(
      renamed.libraries.find((entry) => entry.id === incoming.id)?.name,
    ).toBe("论文库(1)");
    expect(renamed.activeId).toBe(incoming.id);
    await Promise.all([
      reopened.rename(incoming.directory, first.activeId!, "研究"),
      reopened.rename(incoming.directory, incoming.id, "研究"),
    ]);
    const names = (await reopened.list(incoming.directory)).libraries.map(
      (entry) => entry.name,
    );
    expect(names).toEqual(["研究", "研究(1)"]);
    expect(await readFile(join(original, "neoread.sqlite"), "utf8")).toBe(
      "original",
    );
    expect(
      await readFile(join(incoming.directory, "neoread.sqlite"), "utf8"),
    ).toBe("incoming");
    await expect(
      reopened.rename(incoming.directory, incoming.id, " "),
    ).rejects.toThrow("书库名称");
    expect(
      (await reopened.list(original)).libraries.map((entry) => entry.name),
    ).toEqual(names);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
