import type {
  Annotation,
  DocumentLocation,
  DocumentNavigation,
  NavigationEdit,
  PDFBlock,
  TOCItem,
} from "@neoread/core";

export interface NavigationItem extends TOCItem {
  /** Present only for nodes backed by a personal bookmark annotation. */
  bookmarkId?: string;
  kind: "heading" | "bookmark";
  originalLabel: string;
  parentId: string | null;
  collapsed: boolean;
  order: number[];
  children: NavigationItem[];
}
export const emptyNavigation = (): DocumentNavigation => ({
  revision: 0,
  entries: {},
});
export function flattenTOC<T extends TOCItem>(items: T[]): T[] {
  return items.flatMap((item) => [item, ...flattenTOC(item.children as T[])]);
}
export function compareOrder(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
/** Layout blocks already carry the parser's reading order (including columns). */
export function pdfOrder(
  location: DocumentLocation,
  blocks: PDFBlock[],
  fallback = 0,
): number[] {
  if (location.type !== "pdf") return [fallback];
  const page = blocks.filter((b) => b.page === location.page);
  if (location.y === undefined) return [location.page, -1, fallback];
  const x = location.x ?? 0,
    y = location.y;
  let best = -1,
    distance = Infinity;
  page.forEach((b, i) => {
    const r = b.bounds;
    const dx = Math.max(r.x - x, 0, x - r.x - r.width);
    const dy = Math.max(r.y - y, 0, y - r.y - r.height);
    const d = dx * 4 + dy;
    if (d < distance) {
      best = i;
      distance = d;
    }
  });
  if (best >= 0) {
    const b = page[best].bounds;
    return [
      location.page,
      best + Math.max(0, Math.min(0.99, (y - b.y) / Math.max(0.001, b.height))),
      fallback,
    ];
  }
  return [location.page, y, x, fallback];
}
function headingKey(block: PDFBlock) {
  // A reparse can renumber block IDs. Bind edits to page + original title,
  // so an inserted paragraph cannot transfer a rename to a different heading.
  let hash = 2166136261;
  for (const char of block.text.normalize("NFKC").replace(/\s+/g, " ").trim()) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return `heading:${block.page}:${(hash >>> 0).toString(16)}`;
}
function treeFrom(nodes: NavigationItem[]): NavigationItem[] {
  const copies = nodes.map((n) => ({ ...n, children: [] as NavigationItem[] }));
  const byId = new Map(copies.map((n) => [n.id, n]));
  const roots: NavigationItem[] = [];
  for (const n of copies) {
    const parent = n.parentId && byId.get(n.parentId);
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}
const sorted = (nodes: NavigationItem[]) =>
  [...nodes].sort((a, b) => compareOrder(a.order, b.order));
function validParents(nodes: NavigationItem[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const seen = new Set([n.id]);
    let p = n.parentId;
    while (p) {
      if (seen.size > 64 || seen.has(p) || !byId.has(p)) return false;
      seen.add(p);
      p = byId.get(p)!.parentId;
    }
  }
  const order = flattenTOC(treeFrom(sorted(nodes)));
  return order.every(
    (n, i) => i === 0 || compareOrder(order[i - 1].order, n.order) <= 0,
  );
}
/** Recover safely if new parsed blocks invalidate an old hierarchy. Keep edits stored. */
function normalizeParents(nodes: NavigationItem[]) {
  const path: string[] = [];
  for (const n of sorted(nodes)) {
    const at = n.parentId ? path.indexOf(n.parentId) : -1;
    n.parentId = at >= 0 ? n.parentId : null;
    path.splice(at + 1);
    path.push(n.id);
  }
}
export function buildNavigation(
  outline: TOCItem[],
  blocks: PDFBlock[],
  annotations: Annotation[],
  state: DocumentNavigation,
  epubOrders: Record<string, number[]> = {},
): NavigationItem[] {
  const hasOutline = outline.some((i) => !i.id.startsWith("page-"));
  const headings = blocks.filter(
    (b) =>
      (b.label === "paragraph_title" || b.label === "doc_title") &&
      b.text.trim(),
  );
  const occurrences = new Map<string, number>();
  const base: TOCItem[] =
    hasOutline || !headings.length
      ? outline
      : headings.map((b) => {
          const key = headingKey(b),
            occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          return {
            id: `${key}:${occurrence}`,
            label: b.text.trim(),
            location: {
              type: "pdf",
              page: b.page,
              x: b.bounds.x,
              y: b.bounds.y,
            },
            children: [],
          };
        });
  const nodes: NavigationItem[] = [];
  function add(items: TOCItem[], parentId: string | null) {
    for (const item of items) {
      const edit = state.entries[item.id] ?? {};
      let location = item.location;
      if (
        location.type === "pdf" &&
        location.y === undefined &&
        !item.id.startsWith("page-")
      ) {
        const page = location.page;
        const title = (value: string) =>
          value
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]/gu, "");
        const matches = headings.filter(
          (b) =>
            b.page === page &&
            title(b.text) === title(item.originalLabel ?? item.label),
        );
        if (matches.length === 1)
          location = {
            ...location,
            x: matches[0].bounds.x,
            y: matches[0].bounds.y,
          };
      }
      nodes.push({
        ...item,
        location,
        kind: edit.kind ?? item.kind ?? "heading",
        originalLabel: item.originalLabel ?? item.label,
        label: edit.label ?? item.label,
        parentId,
        collapsed: edit.collapsed ?? false,
        children: [],
        order:
          location.type === "pdf"
            ? pdfOrder(location, blocks, nodes.length)
            : [
                ...(epubOrders[item.id] ?? item.order ?? [nodes.length]),
                nodes.length,
              ],
      });
      add(item.children, item.id);
    }
  }
  add(base, null);
  const automatic = new Set<string>();
  for (const a of annotations.filter((a) => a.kind === "bookmark")) {
    const id = `bookmark:${a.id}`,
      edit = state.entries[id] ?? {};
    // A manifest entry and a local annotation must never create duplicate keys.
    if (nodes.some((n) => n.id === id)) continue;
    const originalLabel =
      a.note.trim() ||
      (a.location.type === "pdf" ? `第 ${a.location.page} 页书签` : "书签");
    const fallback = nodes.find(
      (n) =>
        n.location.type === "epub" &&
        a.location.type === "epub" &&
        n.location.href.split("#")[0] === a.location.href.split("#")[0],
    )?.order ?? [nodes.length];
    const order =
      a.location.type === "pdf"
        ? pdfOrder(a.location, blocks, nodes.length)
        : epubOrders[id]
          ? [...epubOrders[id], nodes.length]
          : fallback;
    nodes.push({
      id,
      bookmarkId: a.id,
      label: edit.label ?? originalLabel,
      originalLabel,
      kind: edit.kind ?? "bookmark",
      location: a.location,
      order,
      parentId: null,
      collapsed: edit.collapsed ?? false,
      children: [],
    });
    if (edit.parentId === undefined) automatic.add(id);
  }
  // Resolve explicit parents only once all sources (including personal bookmarks)
  // exist. A directory can become a child of a bookmark converted to a heading.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const parent = state.entries[n.id]?.parentId;
    if (parent !== undefined && (parent === null || byId.has(parent)))
      n.parentId = parent;
  }
  const ordered = sorted(nodes);
  const structural = ordered.filter((n) => !automatic.has(n.id));
  let previous: NavigationItem | undefined;
  for (const n of ordered) {
    if (automatic.has(n.id)) {
      n.parentId = previous?.parentId ?? null;
      const next = structural.find((x) => compareOrder(x.order, n.order) > 0);
      // A bookmark between a heading and its first child must stay inside that
      // heading, otherwise preorder would place the later child before it.
      const seen = new Set<string>();
      let parent = next?.parentId;
      while (parent && !seen.has(parent)) {
        if (parent === previous?.id) {
          n.parentId = previous.id;
          break;
        }
        seen.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
    if (n.kind === "heading" && !n.id.startsWith("page-")) previous = n;
  }
  // New parser evidence can invalidate an old relationship. Preserve the stored
  // override, but render only contiguous source-order subtrees.
  normalizeParents(nodes);
  const retained = nodes.filter((n) => !state.entries[n.id]?.deleted);
  for (const n of retained) {
    const seen = new Set<string>();
    while (
      n.parentId &&
      state.entries[n.parentId]?.deleted &&
      !seen.has(n.parentId)
    ) {
      seen.add(n.parentId);
      n.parentId = byId.get(n.parentId)?.parentId ?? null;
    }
  }
  normalizeParents(retained);
  return treeFrom(sorted(retained));
}
export function moveNavigation(
  tree: NavigationItem[],
  id: string,
  parentId: string | null,
): string | null {
  const nodes = flattenTOC(tree).map((n) => ({ ...n }));
  const item = nodes.find((n) => n.id === id);
  if (id.startsWith("page-") || parentId?.startsWith("page-"))
    return "页码占位条目不支持层级编辑";
  if (
    !item ||
    parentId === id ||
    (parentId && !nodes.some((n) => n.id === parentId))
  )
    return "无法移动到这个目录";
  item.parentId = parentId;
  return validParents(nodes)
    ? null
    : "此移动会打乱原文顺序或产生循环，无法放入该目录";
}
export function editNavigation(
  state: DocumentNavigation,
  id: string,
  patch: NavigationEdit,
): DocumentNavigation {
  return {
    ...state,
    entries: { ...state.entries, [id]: { ...state.entries[id], ...patch } },
  };
}
