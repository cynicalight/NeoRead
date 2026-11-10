import type { PDFBlock, TOCItem } from "@neoread/core";

export interface PageRange {
  fromPage: number;
  toPage: number;
}

/** Section starts found by layout parsing, and the pages parsed so far. */
export interface ParsedHeadings {
  starts: number[];
  parsed: number[];
}

/** Chapter headings for translation, excluding numbered subsections. */
export function headingPages(blocks: PDFBlock[]): ParsedHeadings {
  return {
    starts: blocks
      .filter(
        (b) =>
          (b.label === "paragraph_title" || b.label === "doc_title") &&
          !/^\s*[\dA-Z]+\.\d/.test(b.text),
      )
      .map((b) => b.page),
    parsed: blocks.map((b) => b.page),
  };
}

/**
 * The outline chapter containing `page`, as an inclusive page range. A single
 * root entry (the book title) is skipped for its children. Without an outline
 * (the PDF adapter then lists every page) parsed headings mark the chapters,
 * and an unparsed PDF uses the page and its neighbours.
 */
export function chapterRange(
  toc: TOCItem[],
  page: number,
  pages: number,
  headings?: ParsedHeadings,
): PageRange {
  const entries = toc.length === 1 ? toc[0].children : toc;
  const outline = [
    ...new Set(
      entries.flatMap((item) =>
        item.location.type === "pdf" && !item.id.startsWith("page-")
          ? [item.location.page]
          : [],
      ),
    ),
  ].sort((a, b) => a - b);
  const current = Math.min(Math.max(1, page), pages);
  if (outline.length) {
    const fromPage = outline.filter((start) => start <= current).at(-1) ?? 1;
    const next = outline.find((start) => start > current);
    return { fromPage, toPage: next ? Math.max(fromPage, next - 1) : pages };
  }
  const nearby = {
    fromPage: Math.max(1, current - 1),
    toPage: Math.min(pages, current + 1),
  };
  // Headings bound a section only within the parsed pages around the reader;
  // past them the next chapter may simply not be parsed yet.
  const parsed = new Set(headings?.parsed);
  if (!parsed.has(current)) return nearby;
  let runStart = current;
  let runEnd = current;
  while (parsed.has(runStart - 1)) runStart--;
  while (parsed.has(runEnd + 1)) runEnd++;
  const starts = [...new Set(headings?.starts)]
    .filter((start) => start >= runStart && start <= runEnd)
    .sort((a, b) => a - b);
  if (!starts.length) return nearby;
  const fromPage =
    starts.filter((start) => start <= current).at(-1) ?? nearby.fromPage;
  const next = starts.find((start) => start > current);
  return {
    fromPage,
    toPage: Math.min(pages, next ? Math.max(fromPage, next - 1) : runEnd),
  };
}

/** The outline title starting the range, otherwise its page numbers. */
export function chapterTitle(toc: TOCItem[], range: PageRange): string {
  const entries = toc.length === 1 ? toc[0].children : toc;
  const entry = entries.find(
    (item) =>
      item.location.type === "pdf" &&
      !item.id.startsWith("page-") &&
      item.location.page === range.fromPage,
  );
  if (entry?.label.trim()) return entry.label.trim();
  return range.fromPage === range.toPage
    ? `第 ${range.fromPage} 页`
    : `第 ${range.fromPage}–${range.toPage} 页`;
}
