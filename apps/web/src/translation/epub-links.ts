import type { EPUBLocation, EPUBReadingBlock } from "@neoread/core";
export function epubOffsets(
  location: EPUBLocation,
): { start: number; end: number } | undefined {
  try {
    const loc = JSON.parse(location.locator || "{}").locations;
    const range = loc?.textRange,
      slice = loc?.sourceSlice;
    return range && slice
      ? { start: range.start + slice.start, end: range.start + slice.end }
      : range;
  } catch {
    return;
  }
}
export function epubBlocksAt(
  location: EPUBLocation,
  blocks: EPUBReadingBlock[],
) {
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
  const range = epubOffsets(location);
  if (range)
    return chapter.filter((b) => {
      const r = epubOffsets(b.location);
      return r && r.start < range.end && range.start < r.end;
    });
  const translated = chapter.find(
    (b) => b.id === location.translation?.blockId,
  );
  if (translated) return [translated];
  try {
    const locations = JSON.parse(location.locator || "{}").locations;
    const selector =
      locations?.domRange?.start?.cssSelector || locations?.cssSelector;
    if (selector) {
      const found = chapter.find((b) => {
        const locations = JSON.parse(b.location.locator || "{}").locations;
        const target =
          locations?.domRange?.start?.cssSelector || locations?.cssSelector;
        return target === selector || target?.startsWith(selector + " > ");
      });
      if (found) return [found];
    }
  } catch {
    /* Legacy progress can still open the chapter. */
  }
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
  if (!block.location.locator) return block.location;
  const slice = epubSentenceSlice(block, sentences, indexes);
  if (!slice) return block.location;
  const locator = JSON.parse(block.location.locator);
  locator.locations.sourceSlice = slice;
  return {
    ...block.location,
    blockId: block.id,
    ...slice,
    locator: JSON.stringify(locator),
  };
}
