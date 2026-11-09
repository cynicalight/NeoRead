const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Keep every sentence touched by the match, without clipping words at a budget. */
export function searchExcerpt(
  text: string,
  start: number,
  end: number,
): string {
  const segments = sentences.segment(text);
  const first = segments.containing(start);
  const last = segments.containing(Math.max(start, end - 1));
  return text
    .slice(
      first?.index ?? 0,
      last ? last.index + last.segment.length : text.length,
    )
    .trim();
}
