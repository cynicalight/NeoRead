import { api } from "@neoread/api";
import type { Annotation, EPUBLocation, TOCItem } from "@neoread/core";
import { flattenTOC } from "./navigation-model";

/** Resolve source DOM anchors, never screen pagination or lexicographic filenames. */
export async function epubNavigationOrders(
  id: string,
  toc: TOCItem[],
  annotations: Annotation[],
  signal?: AbortSignal,
  exact = true,
) {
  const chapters = await api.epubChapters(id, signal);
  const bookmarked = new Set(
    annotations
      .filter((a) => a.kind === "bookmark" && a.location.type === "epub")
      .map((a) => (a.location as EPUBLocation).href.split("#")[0]),
  );
  const entries = [
    ...flattenTOC(toc),
    ...annotations
      .filter((a) => a.kind === "bookmark")
      .map((a) => ({ id: `bookmark:${a.id}`, location: a.location })),
  ];
  const details = new Map<
    string,
    Promise<{
      doc: Document;
      blocks: import("@neoread/core").EPUBReadingBlock[];
    }>
  >();
  const ordinal = new Map<string, number>();
  const result: Record<string, number[]> = {};
  for (const entry of entries) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (entry.location.type !== "epub") continue;
    const location: EPUBLocation = entry.location;
    const [href, fragment] = location.href.split("#");
    const chapterIndex = chapters.chapters.findIndex((c) => c.href === href);
    if (chapterIndex < 0) throw new Error("目录条目不属于书籍阅读顺序");
    if (!exact && !bookmarked.has(href)) {
      const index = ordinal.get(href) ?? 0;
      result[entry.id] = [chapterIndex, index];
      ordinal.set(href, index + 1);
      continue;
    }
    if (
      !fragment &&
      !location.blockId &&
      !location.translation?.blockId &&
      location.progression === undefined
    ) {
      result[entry.id] = [chapterIndex, 0];
      continue;
    }
    if (!details.has(href))
      details.set(
        href,
        api.epubChapter(id, href, signal).then((r) => ({
          doc: new DOMParser().parseFromString(r.html, "text/html"),
          blocks: r.blocks ?? chapters.chapters[chapterIndex].blocks,
        })),
      );
    const { doc, blocks: chapter } = await details.get(href)!;
    let offset: number | undefined;
    const block = chapter.find(
      (b) => b.id === (location.blockId ?? location.translation?.blockId),
    );
    if (block)
      offset =
        chapter
          .slice(0, chapter.indexOf(block))
          .reduce((n, b) => n + b.text.length, 0) + (location.start ?? 0);
    if (offset === undefined && fragment) {
      let anchor: Element | null = null;
      try {
        anchor = doc.getElementById(decodeURIComponent(fragment));
      } catch {
        /* invalid fragment */
      }
      if (!anchor) throw new Error("无法定位目录锚点，暂不能调整层级");
      const runs = Array.from(
        doc.querySelectorAll<HTMLElement>("[data-epub-run]"),
      );
      const run = runs.find(
        (n) =>
          anchor!.contains(n) ||
          !!(
            anchor!.compareDocumentPosition(n) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      );
      const target = chapter.find((b) => b.id === run?.dataset.epubRun);
      offset = target
        ? chapter
            .slice(0, chapter.indexOf(target))
            .reduce((n, b) => n + b.text.length, 0)
        : undefined;
      if (offset === undefined) throw new Error("无法确定目录的原文顺序");
    }
    if (offset === undefined && location.progression !== undefined) {
      const end = chapter.reduce((n, b) => n + b.text.length, 0);
      offset = location.progression * end;
    }
    result[entry.id] = [chapterIndex, offset ?? 0];
  }
  return result;
}
