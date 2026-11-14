import {
  locationLabel,
  type ReaderAdapter,
  type ReaderSelection,
  type SourceReference,
} from "@neoread/core";
import { contextReferences } from "../references";

// Mirrors the server request limit. Explicit quotations are never shortened.
export const chatContextBytes = 256000;

/** Capture only what the reader chose, plus a navigation snapshot. */
export async function readingContext(
  adapter: Pick<ReaderAdapter, "getLocation" | "getContext"> | undefined,
  selected: ReaderSelection[],
  useSection: boolean,
  hasImages: boolean,
) {
  const position = adapter?.getLocation();
  const readingLocation = position
    ? position.type === "pdf"
      ? {
          type: "pdf" as const,
          page: position.page,
          x: position.x,
          y: position.y,
        }
      : {
          type: "epub" as const,
          href: position.href,
          progression: position.progression,
          blockId: position.blockId,
          start: position.start,
          end: position.end,
          endBlockId: position.endBlockId,
        }
    : undefined;
  const quotes = structuredClone(useSection ? [] : selected);
  let context = quotes
    .map((quote) => `[选区 · ${locationLabel(quote.location)}]\n${quote.text}`)
    .join("\n\n");
  let references: SourceReference[] = quotes.map(({ text, location }) => ({
    text,
    location,
    kind: "selection",
  }));
  // Pi can use the reading position to retrieve text for an explicit summary.
  // Keep renderer text for explicit requests that also include images.
  if (useSection && hasImages && adapter) {
    context = await adapter.getContext();
    references = readingLocation
      ? contextReferences(context, readingLocation)
      : [];
  }
  if (new TextEncoder().encode(context).length > chatContextBytes)
    throw new Error("引用原文超过 256 KB，请减少引用内容或分开提问。");
  return { context, references, readingLocation };
}
