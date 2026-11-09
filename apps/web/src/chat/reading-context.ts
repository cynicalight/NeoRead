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
  provider: string,
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
          locator: position.locator,
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
  // Only an explicit page/chapter action needs renderer text for providers
  // without document tools. Merely attaching an image never reads the page.
  const documentAgent =
    !hasImages &&
    (provider === "codex" || provider === "claude" || provider === "api");
  if (useSection && !documentAgent && adapter) {
    context = await adapter.getContext();
    references = readingLocation
      ? contextReferences(context, readingLocation)
      : [];
  }
  if (new TextEncoder().encode(context).length > chatContextBytes)
    throw new Error("引用原文超过 256 KB，请减少引用内容或分开提问。");
  return { context, references, readingLocation };
}
