import type { Document, ReaderTheme } from "@neoread/core";

export function readingSession(
  saved: unknown,
  documents: Document[],
): NonNullable<ReaderTheme["readingSession"]> {
  const value = saved as Partial<
    NonNullable<ReaderTheme["readingSession"]>
  > | null;
  const available = new Set(documents.map((doc) => doc.id));
  const documentIds = Array.isArray(value?.documentIds)
    ? [
        ...new Set(
          value.documentIds.filter(
            (id): id is string => typeof id === "string" && available.has(id),
          ),
        ),
      ]
    : [];
  return {
    documentIds,
    activeId:
      typeof value?.activeId === "string" &&
      documentIds.includes(value.activeId)
        ? value.activeId
        : null,
  };
}
