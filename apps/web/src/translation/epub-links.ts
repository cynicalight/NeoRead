import type { EPUBLocation, EPUBReadingBlock } from "@neoread/core";
export function epubBlocksAt(
  location: EPUBLocation,
  blocks: EPUBReadingBlock[],
) {
  if (location.unresolved) return [];
  const chapter = blocks.filter(
    (b) => b.location.href === location.href.split("#")[0],
  );
  if (location.blockId) {
    const start = blocks.findIndex(
      (b) =>
        b.id === location.blockId &&
        b.location.href === location.href.split("#")[0],
    );
    const end = blocks.findIndex(
      (b) => b.id === (location.endBlockId ?? location.blockId),
    );
    return start >= 0 && end >= start ? blocks.slice(start, end + 1) : [];
  }
  const translated = chapter.find(
    (b) => b.id === location.translation?.blockId,
  );
  if (translated) return [translated];
  return chapter.slice(0, 1);
}

/** Match exact UTF-16 offsets without depending on a serialized Readium locator. */
export function epubSentenceSlice(
  block: EPUBReadingBlock,
  sentences: { source: string }[],
  indexes: number[],
): { start: number; end: number } | undefined {
  if (!indexes.length) return;
  const map: number[] = [];
  for (let i = 0; i < block.text.length; i++)
    if (!/\s/.test(block.text[i])) map.push(i);
  const normalize = (text: string) => text.replace(/\s/g, "");
  if (
    normalize(sentences.map((s) => s.source).join("")) !== normalize(block.text)
  )
    return;
  const first = Math.min(...indexes),
    last = Math.max(...indexes);
  const start = normalize(
    sentences
      .slice(0, first)
      .map((s) => s.source)
      .join(""),
  ).length;
  const end = normalize(
    sentences
      .slice(0, last + 1)
      .map((s) => s.source)
      .join(""),
  ).length;
  if (map[start] === undefined || map[end - 1] === undefined) return;
  return { start: map[start], end: map[end - 1] + 1 };
}

/** Retain the paragraph anchor and carry a UTF-16 slice for exact sentence focus. */
export function epubSentenceLocation(
  block: EPUBReadingBlock,
  sentences: { source: string }[],
  indexes: number[],
): EPUBLocation {
  const slice = epubSentenceSlice(block, sentences, indexes);
  return { ...block.location, blockId: block.id, ...(slice ?? {}) };
}
