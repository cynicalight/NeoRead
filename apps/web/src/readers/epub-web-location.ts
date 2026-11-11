import type { EPUBLocation, EPUBReadingBlock } from "@neoread/core";

export type EPUBSlice = { block: EPUBReadingBlock; start: number; end: number };

/** Resolve canonical paragraph ranges; legacy data is migrated by the server. */
export function resolveEPUBLocation(
  location: EPUBLocation,
  blocks: EPUBReadingBlock[],
): EPUBSlice[] {
  if (location.unresolved) return [];
  if (location.blockId) {
    const first = blocks.findIndex(
      (b) =>
        b.id === location.blockId &&
        b.location.href === location.href.split("#")[0],
    );
    const last = blocks.findIndex(
      (b) => b.id === (location.endBlockId ?? location.blockId),
    );
    if (first < 0 || last < first) return [];
    const selected = blocks.slice(first, last + 1);
    const start = location.start ?? 0,
      end = location.end ?? selected.at(-1)!.text.length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < 0 ||
      start > selected[0].text.length ||
      end > selected.at(-1)!.text.length ||
      (first === last && end < start)
    )
      return [];
    return selected.map((block, i) => ({
      block,
      start: i === 0 ? start : 0,
      end: i === selected.length - 1 ? end : block.text.length,
    }));
  }
  return [];
}

export function blockPieces(host: HTMLElement, id: string) {
  const nodes = Array.from(
    host.querySelectorAll<HTMLElement>("[data-epub-run]"),
  )
    .filter((n) => n.dataset.epubRun === id)
    .flatMap((n) =>
      Array.from(n.childNodes).filter(
        (c): c is Text => c.nodeType === Node.TEXT_NODE,
      ),
    );
  const text = nodes.map((n) => n.data).join("");
  return { nodes, leading: text.length - text.trimStart().length };
}

export function blockRange(
  host: HTMLElement,
  slice: EPUBSlice,
): Range | undefined {
  const { nodes, leading } = blockPieces(host, slice.block.id);
  const point = (offset: number, end: boolean): [Text, number] | undefined => {
    let at = offset + leading;
    for (const node of nodes) {
      if (at < node.length || (end && at === node.length)) return [node, at];
      at -= node.length;
    }
    const last = nodes.at(-1);
    return last ? [last, last.length] : undefined;
  };
  const start = point(slice.start, false),
    end = point(slice.end, true);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

export function blockOffset(
  host: HTMLElement,
  block: EPUBReadingBlock,
  node: Node,
  offset: number,
) {
  const { nodes, leading } = blockPieces(host, block.id);
  let at = 0;
  for (const text of nodes) {
    if (text === node) {
      at += offset;
      break;
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    if (range.comparePoint(node, offset) <= 0) break;
    at += text.length;
  }
  return Math.max(0, Math.min(block.text.length, at - leading));
}

/** Extract source runs only, excluding translation companions between them. */
export function sourceEPUBSelection(
  host: HTMLElement,
  range: Range,
  blocks: EPUBReadingBlock[],
) {
  const touched = new Set(
    [...host.querySelectorAll<HTMLElement>("[data-epub-run]")]
      .filter((node) => range.intersectsNode(node))
      .map((node) => node.dataset.epubRun),
  );
  const matches = blocks.filter((block) => {
    if (!touched.has(block.id)) return false;
    const r = blockRange(host, { block, start: 0, end: block.text.length });
    return (
      r &&
      range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, r) > 0
    );
  });
  const first = matches[0],
    last = matches.at(-1);
  if (!first || !last) return;
  const start = blockOffset(
    host,
    first,
    range.startContainer,
    range.startOffset,
  );
  const end = blockOffset(host, last, range.endContainer, range.endOffset);
  const text = matches
    .map((b, i) =>
      b.text.slice(
        i === 0 ? start : 0,
        i === matches.length - 1 ? end : b.text.length,
      ),
    )
    .join("\n\n");
  if (!text.trim()) return;
  const location: EPUBLocation = {
    type: "epub",
    href: first.location.href,
    order: first.location.order,
    blockId: first.id,
    start,
    end,
    quote: text,
    ...(last.id !== first.id ? { endBlockId: last.id } : {}),
    ...(last.location.href !== first.location.href
      ? { endHref: last.location.href }
      : {}),
  };
  return { text, location };
}
