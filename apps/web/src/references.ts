import type {
  DocumentLocation,
  Message,
  SourceReference,
  TOCItem,
} from "@neoread/core";

export interface ReferenceCard {
  kind?: "chat";
  sourceId?: string;
  id: string;
  text: string;
  preview: string;
  label: string;
  location?: DocumentLocation;
}
const compact = (text: string) => text.replace(/\s+/g, " ").trim();
export function referenceLabel(
  location: DocumentLocation,
  toc: TOCItem[],
): string {
  if (location.type === "pdf") return `第 ${location.page} 页`;
  const find = (items: TOCItem[]): TOCItem | undefined => {
    for (const item of items) {
      if (
        item.location.type === "epub" &&
        item.location.href.split("#")[0] === location.href.split("#")[0]
      )
        return item;
      const child = find(item.children);
      if (child) return child;
    }
  };
  return find(toc)?.label || "章节原文";
}
export function referenceCards(
  message: Pick<Message, "references" | "context">,
  toc: TOCItem[],
): ReferenceCard[] {
  const refs = message.references || [];
  if (refs.length)
    return refs.map((ref, index) =>
      ref.kind === "chat"
        ? {
            ...card(ref.text, index, "引用对话"),
            kind: "chat" as const,
          }
        : {
            ...card(
              ref.text,
              index,
              `${ref.sourceId ? `[${ref.sourceId}] · ` : ""}${referenceLabel(ref.location, toc)}${ref.kind === "section" ? "" : " · 重点句"}`,
              ref.location,
            ),
            sourceId: ref.sourceId,
          },
    );
  // Older conversations stored only the raw context. Keep excerpts searchable;
  // never assign today's reading position to historical text.
  const parts: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  for (const paragraph of (message.context || "").split(/\n\s*\n/)) {
    const clean = compact(paragraph.replace(/\[选区[^\]]*\]/g, ""));
    let part = "";
    for (const { segment } of segmenter.segment(clean)) {
      if (part && part.length + segment.length > 320) {
        parts.push(part.trim());
        part = "";
      }
      part += segment;
    }
    if (part.trim()) parts.push(part.trim());
  }
  return parts.map((text, i) => card(text, i, `原文条目 ${i + 1}`));
}
function card(
  text: string,
  index: number,
  label: string,
  location?: DocumentLocation,
): ReferenceCard {
  const clean = compact(text);
  return {
    id: String(index),
    text,
    label,
    location,
    preview: clean.length > 160 ? clean.slice(0, 160) + "…" : clean,
  };
}
export function contextReferences(
  text: string,
  location: DocumentLocation,
): SourceReference[] {
  return text.trim()
    ? [
        {
          text,
          location:
            location.type === "pdf"
              ? { type: "pdf", page: location.page }
              : {
                  type: "epub",
                  href: location.href.split("#")[0],
                  progression: 0,
                },
          kind: "section",
        },
      ]
    : [];
}
