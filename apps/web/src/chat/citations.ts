import { createContext } from "react";
import type { Link, PhrasingContent, Root, Text } from "mdast";
import { SKIP, visit } from "unist-util-visit";

export const ChatCitationNavigation = createContext<
  | {
      sourceIds: string[];
      previews?: Record<string, { text: string; label: string }>;
      navigate: (sourceId: string) => void;
    }
  | undefined
>(undefined);

// Keep paired native forms aligned with document_citations.go.
const sourceList = String.raw`S[1-9][0-9]*(?:[ \t]*[,，、;；][ \t]*S[1-9][0-9]*)*`;
const nativeCitation = String.raw`\[${sourceList}\]|【${sourceList}】|［${sourceList}］|（${sourceList}）|\(${sourceList}\)`;
const citation = new RegExp(`${nativeCitation}|[^]*(?:|)`, "g");
const sourceID = /^S[1-9][0-9]*$/;
const text = (value: string): Text => ({ type: "text", value });

function groupCitationLinks(parts: PhrasingContent[]): PhrasingContent[] {
  const grouped: PhrasingContent[] = [];
  for (let i = 0; i < parts.length; i++) {
    const first = parts[i];
    if (first.type !== "link") {
      grouped.push(first);
      continue;
    }
    const ids = new Set(
      new URLSearchParams(first.url.split("?")[1]).getAll("source"),
    );
    let next = i + 1;
    while (next < parts.length) {
      const gap = parts[next];
      const candidateIndex =
        gap.type === "text" && /^\s*$/.test(gap.value) ? next + 1 : next;
      const candidate = parts[candidateIndex];
      if (candidate?.type !== "link") break;
      new URLSearchParams(candidate.url.split("?")[1])
        .getAll("source")
        .forEach((id) => ids.add(id));
      i = candidateIndex;
      next = i + 1;
    }
    const params = new URLSearchParams();
    ids.forEach((id) => params.append("source", id));
    grouped.push({
      ...first,
      url: `#neoread-evidence?${params}`,
      children: [...ids].map((id) => text(`[${id}]`)),
    });
  }
  return grouped;
}

// Only saved, server-validated sources become links. Pending answers retain
// readable labels until their message and evidence have been committed.
export function remarkChatCitations({
  sourceIds = [],
  generating = false,
}: { sourceIds?: string[]; generating?: boolean } = {}) {
  const known = new Set(sourceIds);
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "text" || !parent || index === undefined) return;
      const parts: PhrasingContent[] = [];
      let start = 0;
      for (const match of node.value.matchAll(citation)) {
        parts.push(text(node.value.slice(start, match.index)));
        const raw = match[0];
        start = match.index + raw.length;
        const native = !raw.startsWith("");
        const markerParts = raw.replace(/^|$/g, "").split("");
        const kind = markerParts[0];
        if (
          !native &&
          !["cite", "filecite"].some(
            (name) => name.startsWith(kind) || kind.startsWith(name),
          )
        ) {
          parts.push(text(raw));
          continue;
        }
        const complete = native || raw.endsWith("");
        const ids = native
          ? (raw.match(/S[1-9][0-9]*/g) ?? [])
          : markerParts.slice(1);
        if (!complete) {
          parts.push(text(generating ? "" : "[引用未完成]"));
        } else if (
          (!native && kind !== "cite" && kind !== "filecite") ||
          !ids.length ||
          !ids.every((id) => sourceID.test(id))
        ) {
          parts.push(text("[引用不可用]"));
        } else {
          for (const id of ids) {
            const label = `[${id}]`;
            parts.push(
              known.has(id)
                ? ({
                    type: "link",
                    url: `#neoread-evidence?source=${id}`,
                    children: [text(label)],
                  } satisfies Link)
                : text(label),
            );
          }
        }
      }
      if (!start) return;
      parts.push(text(node.value.slice(start)));
      const visible = groupCitationLinks(
        parts.filter((part) => part.type !== "text" || part.value),
      );
      (parent.children as PhrasingContent[]).splice(index, 1, ...visible);
      return [SKIP, index + visible.length];
    });
  };
}
