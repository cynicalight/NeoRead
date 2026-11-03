import { randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  rename,
  rm,
  mkdir,
  stat,
  realpath,
} from "node:fs/promises";
import { join, basename, isAbsolute } from "node:path";
import {
  uniqueLibraryName,
  type LibraryEntry,
  type LibraryCatalogSnapshot,
} from "../../../packages/neoread-core/src/library-archive";

/** Machine-local library locations and names; library contents stay in their folders. */
export class LibraryCatalog {
  private queue: Promise<unknown> = Promise.resolve();
  private names = new Map<string, string>();
  cachedName(directory: string) {
    return this.names.get(directory);
  }
  constructor(private userData: string) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private async read(): Promise<LibraryEntry[]> {
    try {
      const value = JSON.parse(
        await readFile(join(this.userData, "library-catalog.json"), "utf8"),
      );
      if (
        !Array.isArray(value.libraries) ||
        value.libraries.some(
          (entry: LibraryEntry) =>
            !entry ||
            typeof entry.id !== "string" ||
            typeof entry.name !== "string" ||
            typeof entry.directory !== "string" ||
            !isAbsolute(entry.directory),
        )
      )
        throw new Error("已保存的书库列表无效。");
      return value.libraries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async save(libraries: LibraryEntry[]) {
    await mkdir(this.userData, { recursive: true });
    const temporary = join(
      this.userData,
      `library-catalog.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, JSON.stringify({ libraries }) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, join(this.userData, "library-catalog.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async ensure(active: string) {
    const libraries = await this.read();
    const count = libraries.length;
    const roots = [join(this.userData, "library"), active].filter(Boolean);
    for (const root of roots) {
      let directory: string;
      try {
        if (!(await stat(join(root, "neoread.sqlite"))).isFile()) continue;
        directory = await realpath(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!libraries.some((entry) => entry.directory === directory)) {
        libraries.push({
          id: randomUUID(),
          directory,
          name: uniqueLibraryName(
            root === roots[0] ? "论文库" : basename(root),
            libraries.map((entry) => entry.name),
          ),
        });
      }
    }
    if (libraries.length !== count) await this.save(libraries);
    return libraries;
  }
  list(active: string): Promise<LibraryCatalogSnapshot> {
    return this.run(async () => {
      const libraries = await this.ensure(active);
      const directory = active
        ? await realpath(active).catch(() => active)
        : "";
      const current = libraries.find((entry) => entry.directory === directory);
      if (current) this.names.set(active, current.name);
      return {
        libraries,
        activeId: current?.id ?? null,
      };
    });
  }
  allocate(active: string, name: string): Promise<LibraryEntry> {
    return this.run(async () => {
      const libraries = await this.ensure(active);
      const id = randomUUID();
      await mkdir(join(this.userData, "libraries"), { recursive: true });
      return {
        id,
        name: uniqueLibraryName(
          name.slice(0, 80).trim() || "书库",
          libraries.map((entry) => entry.name),
        ),
        directory: join(this.userData, "libraries", id),
      };
    });
  }
  remember(entry: LibraryEntry) {
    return this.run(async () => {
      const libraries = await this.read();
      const directory = await realpath(entry.directory);
      if (!libraries.some((item) => item.directory === directory))
        libraries.push({
          ...entry,
          directory,
          name: uniqueLibraryName(
            entry.name,
            libraries.map((item) => item.name),
          ),
        });
      await this.save(libraries);
    });
  }
  rename(
    active: string,
    id: string,
    name: string,
  ): Promise<LibraryCatalogSnapshot> {
    return this.run(async () => {
      const libraries = await this.ensure(active);
      const entry = libraries.find((item) => item.id === id);
      if (!entry) throw new Error("书库已不存在。");
      entry.name = uniqueLibraryName(
        name,
        libraries.filter((item) => item.id !== id).map((item) => item.name),
      );
      await this.save(libraries);
      const directory = active
        ? await realpath(active).catch(() => active)
        : "";
      const current = libraries.find((item) => item.directory === directory);
      if (current) this.names.set(active, current.name);
      return {
        libraries,
        activeId:
          libraries.find((item) => item.directory === directory)?.id ?? null,
      };
    });
  }
}
