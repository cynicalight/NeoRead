import {
  isPDFPageDecoration,
  type PDFBlock,
  type SearchResult,
  type TranslationBlock,
} from "@reader/core";

/** Search the text shown by the bilingual reader, retaining paragraph anchors. */
export function searchPDFBlocks(
  query: string,
  blocks: PDFBlock[],
  translations: TranslationBlock[],
): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const translated = new Map(translations.map((item) => [item.blockId, item]));
  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (block.image || isPDFPageDecoration(block)) continue;
    const translation = translated.get(block.id);
    const complete =
      translation?.status === "complete" && translation.sentences.length > 0;
    const texts = complete
      ? [
          {
            side: "source" as const,
            text: translation.sentences.map((s) => s.source).join(" "),
          },
          {
            side: "translation" as const,
            text: translation.sentences.map((s) => s.target).join(" "),
          },
        ]
      : [{ side: "source" as const, text: block.text }];
    for (const { side, text } of texts) {
      const lower = text.toLocaleLowerCase();
      let from = 0;
      while (from < lower.length && results.length < 100) {
        const index = lower.indexOf(needle, from);
        if (index < 0) break;
        results.push({
          id: `${block.id}:${side}:${index}`,
          blockId: block.id,
          side,
          excerpt: text.slice(
            Math.max(0, index - 35),
            index + needle.length + 60,
          ),
          location: {
            type: "pdf",
            page: block.page,
            ...(side === "source"
              ? { quote: query.trim(), quoteContext: { text, start: index } }
              : {}),
            x: block.bounds.x + block.bounds.width / 2,
            y: block.bounds.y + block.bounds.height / 2,
          },
        });
        from = index + Math.max(1, needle.length);
      }
    }
    if (results.length >= 100) break;
  }
  return results;
}
