import { figureReferences } from "./readers/figure-references";
import { createContext } from "react";
import { toast } from "sonner";
import type { Link, PhrasingContent, Root, Text } from "mdast";
import { SKIP, visit } from "unist-util-visit";

export const ReadingLinkNavigation = createContext<
  ((blockId: string, label: string) => void) | undefined
>(undefined);

export function openExternalLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.neoreadDesktop?.openExternal)
    void window.neoreadDesktop
      .openExternal(url)
      .catch((e) => toast.error(e.message));
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function citationHref(blockId: string, label: string) {
  return `#neoread-citation?${new URLSearchParams({ block: blockId, label })}`;
}

const citationPattern = /\[(\d+(?:\s*[,，–-]\s*\d+)*)\]/g;
// Longer spans are more likely years or misreads than citation runs.
const maxExpandedRange = 20;

// Work on parsed Markdown text nodes so code, links and math stay untouched.
export function remarkReadingCitations({ blockId }: { blockId?: string }) {
  return (tree: Root) => {
    if (!blockId) return;
    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "text" || !parent || index === undefined) return;
      const parts = readingParts(node.value, blockId);
      if (!parts) return;
      // Text only lives in phrasing parents.
      (parent.children as PhrasingContent[]).splice(index, 1, ...parts);
      return [SKIP, index + parts.length];
    });
  };
}
function readingParts(value: string, blockId: string) {
  const figures = figureReferences(value);
  if (!figures.length) return citationParts(value, blockId);
  const parts: PhrasingContent[] = [];
  let start = 0;
  for (const figure of figures) {
    const before = value.slice(start, figure.index);
    parts.push(...(citationParts(before, blockId) ?? [text(before)]), {
      type: "link",
      url: citationHref(blockId, `figure:${figure.label}`),
      children: [text(figure.text)],
    });
    start = figure.index + figure.text.length;
  }
  const after = value.slice(start);
  parts.push(...(citationParts(after, blockId) ?? [text(after)]));
  return parts;
}
function citationParts(value: string, blockId: string) {
  const parts: PhrasingContent[] = [];
  let start = 0;
  for (const match of value.matchAll(citationPattern)) {
    parts.push(
      text(value.slice(start, match.index) + "["),
      ...citationList(match[1], blockId),
      text("]"),
    );
    start = match.index + match[0].length;
  }
  if (!start) return;
  parts.push(text(value.slice(start)));
  return parts.filter((part) => part.type !== "text" || part.value);
}
/** "3–5, 8" links 3, 4, 5 and 8; separators between items stay as written. */
function citationList(list: string, blockId: string): PhrasingContent[] {
  const link = (label: string): Link => ({
    type: "link",
    url: citationHref(blockId, label),
    children: [text(label)],
  });
  const comma = list.includes("，") ? "，" : ", ";
  return list.split(/(\s*[,，]\s*)/).flatMap((item, i) => {
    if (i % 2) return [text(item)];
    const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(item);
    const from = Number(range?.[1]),
      to = Number(range?.[2]);
    if (range && to > from && to - from <= maxExpandedRange)
      return Array.from({ length: to - from + 1 }, (_, k) =>
        String(from + k),
      ).flatMap((label, k) => (k ? [text(comma), link(label)] : [link(label)]));
    return item
      .split(/(\d+)/)
      .filter(Boolean)
      .map((token) => (/^\d+$/.test(token) ? link(token) : text(token)));
  });
}
const text = (value: string): Text => ({ type: "text", value });

/**
 * Citation and figure links in plain text. Unlike the Markdown pass, ranges
 * are not expanded, so the original text stays exactly as extracted.
 */
export function readingLinkTokens(value: string) {
  const tokens: { text: string; label?: string }[] = [];
  const push = (part: string, label?: string) => {
    if (!part) return;
    const last = tokens.at(-1);
    if (!label && last && !last.label) last.text += part;
    else tokens.push({ text: part, label });
  };
  const citations = (part: string) => {
    let start = 0;
    for (const match of part.matchAll(citationPattern)) {
      push(part.slice(start, match.index + 1));
      for (const token of match[1].split(/(\d+)/))
        push(token, /^\d+$/.test(token) ? token : undefined);
      start = match.index + match[0].length - 1;
    }
    push(part.slice(start));
  };
  let start = 0;
  for (const figure of figureReferences(value)) {
    citations(value.slice(start, figure.index));
    push(figure.text, `figure:${figure.label}`);
    start = figure.index + figure.text.length;
  }
  citations(value.slice(start));
  return tokens;
}
