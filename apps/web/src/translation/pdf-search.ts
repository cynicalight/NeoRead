import { searchExcerpt } from "../readers/search-excerpt";
import {
  isPDFPageDecoration,
  type PDFBlock,
  type SearchResult,
  type TranslationBlock,
} from "@neoread/core";

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
        let sentenceStart = 0;
        const sentenceIndexes =
          translation?.sentences.flatMap((sentence, i) => {
            const length = sentence.target.length;
            const hit =
              index < sentenceStart + length &&
              index + needle.length > sentenceStart;
            sentenceStart += length + 1;
            return hit ? [i] : [];
          }) ?? [];
        results.push({
          id: `${block.id}:${side}:${index}`,
          blockId: block.id,
          side,
          excerpt: searchExcerpt(text, index, index + needle.length),
          location: {
            type: "pdf",
            page: block.page,
            quote: query.trim(),
            quoteContext: { text, start: index },
            ...(side === "translation"
              ? {
                  translation: {
                    blockId: block.id,
                    sourceHash: translation!.sourceHash,
                    sentenceIndexes,
                    start: index - (sentenceIndexes[0] ?? 0),
                    end: index + needle.length - (sentenceIndexes.at(-1) ?? 0),
                  },
                }
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
