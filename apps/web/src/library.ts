import type { Document, TagBoard } from "@neoread/core";

export function displayTitleTranslation(doc: Document) {
  const translation = doc.metadata.translatedTitle?.trim();
  if (!translation) return;
  const normalize = (title: string) =>
    title.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalize(translation) !== normalize(doc.title)) return translation;
}

export interface LibraryFilters {
  format: string;
  reading: string;
  tags: string[];
  sort: string;
}
export const initialFilters: LibraryFilters = {
  format: "all",
  reading: "all",
  tags: [],
  sort: "recent",
};
export function libraryTags(documents: Document[]) {
  const tags = new Map<string, string>();
  for (const d of documents)
    for (const tag of d.tags)
      if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  return [...tags.values()].sort((a, b) => a.localeCompare(b, "zh"));
}
export function filterDocuments(
  documents: Document[],
  view: string,
  query: string,
  filters: LibraryFilters,
) {
  const text = query.trim().toLocaleLowerCase();
  return documents
    .filter((d) => {
      const tags = d.tags.map((tag) => tag.toLowerCase());
      return (
        (view !== "favorites" || d.favorite) &&
        (filters.format === "all" || d.type === filters.format) &&
        (filters.reading === "all" ||
          (filters.reading === "unread"
            ? d.percentage === 0
            : filters.reading === "finished"
              ? d.percentage >= 1
              : d.percentage > 0 && d.percentage < 1)) &&
        filters.tags.every((tag) => tags.includes(tag.toLowerCase())) &&
        `${d.title} ${d.author} ${d.tags.join(" ")} ${d.metadata.translatedTitle ?? ""}`
          .toLocaleLowerCase()
          .includes(text)
      );
    })
    .sort((a, b) =>
      filters.sort === "title"
        ? a.title.localeCompare(b.title, "zh")
        : filters.sort === "added"
          ? b.createdAt.localeCompare(a.createdAt)
          : b.lastOpenedAt.localeCompare(a.lastOpenedAt),
    );
}

export function matchTagBoard(
  documents: Document[],
  board: Pick<TagBoard, "tags" | "match">,
) {
  if (!board.tags.length) return documents;
  return documents.filter((document) => {
    const tags = new Set(document.tags.map((tag) => tag.toLowerCase()));
    const matches = (tag: string) => tags.has(tag.toLowerCase());
    return board.match === "any"
      ? board.tags.some(matches)
      : board.tags.every(matches);
  });
}
