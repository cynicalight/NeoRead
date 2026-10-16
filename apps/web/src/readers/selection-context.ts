/** Keep context local to the rendered page/chapter and the exact DOM range. */
export function selectionContext(range: Range, root: Node) {
  return {
    before: collectContext(root, range.startContainer, range.startOffset, true),
    after: collectContext(root, range.endContainer, range.endOffset, false),
  };
}

export function nearbyWords(text: string, before: boolean) {
  // Bound punctuation-only input too. Han characters count individually.
  text = before ? text.slice(-4000) : text.slice(0, 4000);
  const words = [
    ...text.matchAll(/\p{Script=Han}|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu),
  ];
  if (words.length > 30) {
    text = before
      ? text.slice(words[words.length - 30].index)
      : text.slice(0, words[30].index);
  }
  return text.trim();
}

// Walk outward from the boundary, never cloning a chapter or scanning from its start.
// A node budget also bounds work in empty or deeply nested markup.
function collectContext(
  root: Node,
  boundary: Node,
  offset: number,
  before: boolean,
) {
  if (!root.contains(boundary)) return "";
  let text = "";
  const append = (part: string) => {
    const remaining = 4000 - text.length;
    if (remaining <= 0) return;
    part = before ? part.slice(-remaining) : part.slice(0, remaining);
    text = before ? part + text : text + part;
  };
  const enough = () =>
    text.length >= 4000 ||
    [...text.matchAll(/\p{Script=Han}|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)]
      .length > 30;
  let node = boundary;
  let enter = false;
  if (boundary.nodeType === 3) {
    const data = (boundary as Text).data;
    append(
      before
        ? data.slice(Math.max(0, offset - 4000), offset)
        : data.slice(offset, offset + 4000),
    );
  } else {
    const child = boundary.childNodes[before ? offset - 1 : offset];
    if (child) {
      node = child;
      enter = true;
    }
  }
  for (let visited = 0; visited < 512 && !enough(); visited++) {
    if (enter) {
      if (node.nodeType === 3) {
        const data = (node as Text).data;
        append(before ? data.slice(-4000) : data.slice(0, 4000));
      } else {
        if (separatesWords(node)) append(" ");
        const child = before ? node.lastChild : node.firstChild;
        if (child) {
          node = child;
          continue;
        }
      }
    }
    if (node === root) break;
    if (separatesWords(node)) append(" ");
    const sibling = before ? node.previousSibling : node.nextSibling;
    if (sibling) {
      node = sibling;
      enter = true;
    } else {
      if (!node.parentNode) break;
      node = node.parentNode;
      enter = false;
    }
  }
  return nearbyWords(text, before).replace(/\s+/g, " ");
}

// Preserve paragraph and PDF span boundaries without splitting inline markup.
function separatesWords(node: Node) {
  return (
    node.nodeType === 1 &&
    (node as Element).matches(
      "p,div,li,br,section,h1,h2,h3,h4,h5,h6,span[role=presentation]",
    )
  );
}
