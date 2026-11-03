export interface LibraryArchiveOptions {
  library?: "books" | "papers";
  folder?: string;
  smartCategory?: string;
  name?: string;
}
export type LibraryArchiveImportMode = "new" | "merge";

export interface LibraryEntry {
  id: string;
  name: string;
  directory: string;
}
export interface LibraryCatalogSnapshot {
  libraries: LibraryEntry[];
  activeId: string | null;
}

export function uniqueLibraryName(name: string, names: string[]): string {
  name = name.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name))
    throw new Error("书库名称须为 1–80 个字符。");
  const used = new Set(names.map((item) => item.toLocaleLowerCase()));
  let next = name;
  for (let index = 1; used.has(next.toLocaleLowerCase()); index++) {
    const suffix = `(${index})`;
    next = `${name.slice(0, 80 - suffix.length)}${suffix}`;
  }
  return next;
}

export function libraryArchiveFilename(options: LibraryArchiveOptions = {}) {
  const name =
    options.name ||
    options.folder?.split("/").at(-1) ||
    (options.library === "papers"
      ? "NeoRead论文库"
      : options.library === "books"
        ? "NeoRead图书库"
        : "NeoRead书库");
  return (
    name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") +
    ".zip"
  );
}
