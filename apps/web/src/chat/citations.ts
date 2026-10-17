import { createContext } from "react";
import type { Link, PhrasingContent, Root, Text } from "mdast";
import { SKIP, visit } from "unist-util-visit";

export const ChatCitationNavigation = createContext<
  | {
      sourceIds: string[];
      navigate: (sourceId: string) => void;
    }
  | undefined
>(undefined);

const citation = /\[S[1-9][0-9]*\]|[^]*(?:|)/g;
const sourceID = /^S[1-9][0-9]*$/;
const text = (value: string): Text => ({ type: "text", value });

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
        const markerParts = raw.replace(/^|$/g, "").split("");
        const kind = markerParts[0];
        if (
          !raw.startsWith("[") &&
          !["cite", "filecite"].some(
            (name) => name.startsWith(kind) || kind.startsWith(name),
          )
        ) {
          parts.push(text(raw));
          continue;
        }
        const complete = raw.startsWith("[") || raw.endsWith("");
        const ids = raw.startsWith("[")
          ? [raw.slice(1, -1)]
          : markerParts.slice(1);
        if (!complete) {
          parts.push(text(generating ? "" : "[引用未完成]"));
        } else if (
          (!raw.startsWith("[") && kind !== "cite" && kind !== "filecite") ||
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
                    url: `#reader-evidence?source=${id}`,
                    children: [text(label)],
                  } satisfies Link)
                : text(label),
            );
          }
        }
      }
      if (!start) return;
      parts.push(text(node.value.slice(start)));
      const visible = parts.filter(
        (part) => part.type !== "text" || part.value,
      );
      (parent.children as PhrasingContent[]).splice(index, 1, ...visible);
      return [SKIP, index + visible.length];
    });
  };
}
