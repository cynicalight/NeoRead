import type {
  Document,
  PaperColumn,
  PaperLibraryPreferences,
  SmartCategory,
  PaperSort,
  Processing,
  ReadingStatus,
} from "@reader/core";
import {
  paperCreators,
  creatorName,
  paperYear,
  publicationDate,
  wasOpened,
} from "./format";

export type BuiltinView =
  | "all"
  | "reading"
  | "unread"
  | "done"
  | "starred"
  | "processing"
  | "questions"
  | "unfiled"
  | "duplicates";
/**
 * A built-in view, a category ("folder:<path>"), a smart tag category
 * ("smart:<id>"), one tag ("tag:<name>") or the trash.
 */
export type PaperView =
  | BuiltinView
  | `folder:${string}`
  | `smart:${string}`
  | `tag:${string}`
  | "trash";

export const viewLabels: Record<BuiltinView, string> = {
  all: "全部论文",
  reading: "在读",
  unread: "未读",
  done: "已读",
  starred: "星标",
  processing: "解析中",
  questions: "待回答的问题",
  unfiled: "未分类",
  duplicates: "重复的论文",
};
/** Views the user can hide or pin; "all" is always shown. */
export const managedViews: BuiltinView[] = [
  "reading",
  "unread",
  "done",
  "starred",
];
export const statusLabels: Record<ReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  done: "已读",
};
export const sortLabels: Record<PaperSort, string> = {
  opened: "最近打开",
  added: "最近添加",
  year: "年份",
  published: "发表日期",
  progress: "阅读进度",
  size: "文件大小",
  title: "标题",
  author: "作者",
  venue: "出处",
  status: "阅读状态",
  notes: "批注数",
};
export const columnLabels: Record<PaperColumn, string> = {
  authors: "作者",
  year: "年份",
  published: "发表日期",
  venue: "出处",
  tags: "标签",
  progress: "阅读进度",
  doi: "DOI",
  arxiv: "arXiv 编号",
  size: "文件大小",
  added: "添加时间",
  opened: "上次打开",
  notes: "批注",
  status: "状态",
};
export const defaultColumnWidths: Record<PaperColumn, number> = {
  authors: 160,
  year: 64,
  published: 112,
  tags: 160,
  progress: 96,
  doi: 180,
  arxiv: 132,
  size: 96,
  venue: 150,
  added: 112,
  opened: 112,
  notes: 96,
  status: 72,
};

export const defaultColumns: PaperColumn[] = [
  "authors",
  "year",
  "venue",
  "status",
];
/** The sort a column header applies. */
export const columnSort: Partial<Record<PaperColumn | "title", PaperSort>> = {
  title: "title",
  authors: "author",
  year: "year",
  published: "published",
  progress: "progress",
  size: "size",
  venue: "venue",
  added: "added",
  opened: "opened",
  notes: "notes",
  status: "status",
};
/** Sorts whose natural order is newest or largest first. */
export const descendingSorts: ReadonlySet<PaperSort> = new Set([
  "opened",
  "added",
  "year",
  "published",
  "progress",
  "size",
  "notes",
]);
/** Show or hide a column, keeping the canonical column order. */
export function toggleColumn(columns: PaperColumn[], column: PaperColumn) {
  const on = new Set(columns);
  if (on.has(column)) on.delete(column);
  else on.add(column);
  return (Object.keys(columnLabels) as PaperColumn[]).filter((c) => on.has(c));
}

const busy = (job?: Processing) =>
  !!job &&
  job.enabled !== false &&
  !["complete", "failed", "paused"].includes(job.status);

/** Categories nest by "/": "ML/Vision" is inside "ML". */
export const categoryParent = (name: string) => {
  const at = name.lastIndexOf("/");
  return at > 0 ? name.slice(0, at) : "";
};
export const categoryLeaf = (name: string) =>
  name.slice(name.lastIndexOf("/") + 1);
/** Whether `tag` is `name` itself or nested anywhere below it. */
export function withinCategory(tag: string, name: string) {
  const a = tag.toLowerCase();
  const b = name.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const hasTag = (doc: Pick<Document, "tags">, name: string) =>
  doc.tags.some((tag) => sameName(tag, name));

/** A smart category holds the papers that carry every one of its tags. */
export const inSmartCategory = (
  doc: Pick<Document, "tags">,
  smart: Pick<SmartCategory, "tags">,
) => smart.tags.length > 0 && smart.tags.every((tag) => hasTag(doc, tag));

export interface ViewContext {
  /** A category also lists its subcategories' papers (default on). */
  subcategories?: boolean;
  smart?: SmartCategory[];
}

export function matchesView(
  doc: Document,
  view: PaperView,
  jobs: Map<string, Processing>,
  context: ViewContext = {},
) {
  if (view.startsWith("folder:")) {
    const name = view.slice(7);
    return doc.folders.some((folder) =>
      context.subcategories === false
        ? sameName(folder, name)
        : withinCategory(folder, name),
    );
  }
  if (view.startsWith("smart:")) {
    const smart = context.smart?.find((item) => item.id === view.slice(6));
    return !!smart && inSmartCategory(doc, smart);
  }
  if (view.startsWith("tag:")) return hasTag(doc, view.slice(4));
  switch (view) {
    case "reading":
    case "unread":
    case "done":
      return doc.readingStatus === view;
    case "starred":
      return doc.favorite;
    case "processing":
      return busy(jobs.get(doc.id));
    case "questions":
      return doc.openQuestionCount > 0;
    case "unfiled":
      return doc.folders.length === 0;
    case "duplicates":
      // Needs the whole library: see duplicateGroups.
      return false;
    default:
      return true;
  }
}

export function searchText(doc: Document) {
  const m = doc.metadata;
  return [
    doc.title,
    m.translatedTitle,
    m.remark,
    m.shortTitle,
    paperCreators(doc).map(creatorName).join(" "),
    m.venue,
    m.arxiv,
    m.doi,
    m.date,
    m.abstract,
    doc.tags.join(" "),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
}

const firstAuthor = (doc: Document) => {
  const first = paperCreators(doc)[0];
  return first ? first.family || first.name || first.given || "" : "";
};
const statusRank = { reading: 0, unread: 1, done: 2 };
/** Text keys sort A–Z with empty values last. */
const byText =
  (key: (doc: Document) => string) => (a: Document, b: Document) => {
    const x = key(a);
    const y = key(b);
    if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
    return x.localeCompare(y, "zh");
  };

/** Natural order per key: newest, most annotated or A–Z first. */
export function sortPapers(docs: Document[], sort: PaperSort, reverse = false) {
  const title = byText((d) => d.title);
  const numeric: Partial<
    Record<PaperSort, (doc: Document) => number | undefined>
  > = {
    opened: (d) => (wasOpened(d) ? Date.parse(d.lastOpenedAt) : undefined),
    added: (d) => Date.parse(d.createdAt),
    year: (d) => publicationDate(d.metadata.date)?.year,
    published: (d) => publicationDate(d.metadata.date)?.key,
    progress: (d) => d.percentage,
    size: (d) => (d.size > 0 ? d.size : undefined),
  };
  const numberKey = numeric[sort];
  const tie = (a: Document, b: Document) =>
    title(a, b) || a.id.localeCompare(b.id);
  if (numberKey)
    return [...docs].sort((a, b) => {
      const x = numberKey(a),
        y = numberKey(b);
      const hasX = x !== undefined && Number.isFinite(x);
      const hasY = y !== undefined && Number.isFinite(y);
      // Missing values stay last, independently of direction.
      if (!hasX || !hasY) return Number(hasY) - Number(hasX) || tie(a, b);
      return (reverse ? x - y : y - x) || tie(a, b);
    });
  const by: Partial<Record<PaperSort, (a: Document, b: Document) => number>> = {
    title,
    author: (a, b) => byText(firstAuthor)(a, b) || title(a, b),
    venue: (a, b) => byText((d) => d.metadata.venue || "")(a, b) || title(a, b),
    status: (a, b) =>
      statusRank[a.readingStatus] - statusRank[b.readingStatus] ||
      b.lastOpenedAt.localeCompare(a.lastOpenedAt),
    notes: (a, b) =>
      b.noteCount + b.highlightCount - (a.noteCount + a.highlightCount) ||
      title(a, b),
  };
  const compare = by[sort] || title;
  return [...docs].sort(
    (a, b) =>
      (reverse ? -compare(a, b) : compare(a, b)) || a.id.localeCompare(b.id),
  );
}

/**
 * Every whitespace-separated term must appear somewhere in the paper. The
 * duplicates view keeps each group together instead of sorting.
 */
export function filterPapers(
  docs: Document[],
  view: PaperView,
  query: string,
  sort: PaperSort,
  jobs: Map<string, Processing>,
  options: ViewContext & { notDuplicates?: string[]; reverse?: boolean } = {},
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = (doc: Document) => {
    if (!terms.length) return true;
    const text = searchText(doc);
    return terms.every((term) => text.includes(term));
  };
  if (view === "duplicates")
    return duplicateGroups(docs, options.notDuplicates).flat().filter(found);
  return sortPapers(
    docs.filter((doc) => matchesView(doc, view, jobs, options) && found(doc)),
    sort,
    options.reverse,
  );
}

const comparableTitle = (title: string) =>
  title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
/** arXiv DOIs (10.48550/arXiv.…) name the preprint, not a published version. */
const publishedDOI = (doi?: string) =>
  doi && !/^10\.48550\//i.test(doi) ? doi.toLowerCase() : "";
/** Key for a pair of papers the user marked as not duplicates. */
export const pairKey = (a: string, b: string) =>
  a < b ? `${a}:${b}` : `${b}:${a}`;

/**
 * Papers that are probably the same work: a shared DOI or arXiv ID, or the
 * same title with no conflicting DOI and years at most one apart (a preprint
 * and its published version). Groups list their oldest import first.
 */
export function duplicateGroups(
  docs: Document[],
  notDuplicates: string[] = [],
) {
  const distinct = new Set(notDuplicates);
  const parent = docs.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  const buckets = new Map<string, number[]>();
  const add = (key: string, i: number) => {
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  };
  docs.forEach((doc, i) => {
    const m = doc.metadata;
    if (publishedDOI(m.doi)) add(`doi:${publishedDOI(m.doi)}`, i);
    if (m.arxiv) add(`arxiv:${m.arxiv.toLowerCase().replace(/v\d+$/, "")}`, i);
    const title = comparableTitle(doc.title);
    if ([...title].length >= 10) add(`title:${title}`, i);
  });
  const compatible = (a: Document, b: Document) => {
    const doiA = publishedDOI(a.metadata.doi);
    const doiB = publishedDOI(b.metadata.doi);
    if (doiA && doiB && doiA !== doiB) return false;
    const yearA = Number(paperYear(a.metadata));
    const yearB = Number(paperYear(b.metadata));
    return !yearA || !yearB || Math.abs(yearA - yearB) <= 1;
  };
  for (const [key, list] of buckets)
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const a = docs[list[x]];
        const b = docs[list[y]];
        if (distinct.has(pairKey(a.id, b.id))) continue;
        if (key.startsWith("title:") && !compatible(a, b)) continue;
        parent[find(list[x])] = find(list[y]);
      }
  const groups = new Map<number, Document[]>();
  docs.forEach((doc, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) || []), doc]);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) =>
      [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
}

/**
 * Saved category order followed by tags that only exist on papers. Parents of
 * nested categories are listed even when no paper is filed directly in them.
 */
export function paperCategories(
  prefs: PaperLibraryPreferences,
  docs: Document[],
) {
  const saved = [...(prefs.categories || [])];
  const known = new Set(saved.map((name) => name.toLowerCase()));
  const extra = new Map<string, string>();
  for (const doc of docs)
    for (const folder of doc.folders)
      if (!known.has(folder.toLowerCase()) && !extra.has(folder.toLowerCase()))
        extra.set(folder.toLowerCase(), folder);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [
    ...saved,
    ...[...extra.values()].sort((a, b) => a.localeCompare(b, "zh")),
  ]) {
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!path || seen.has(path.toLowerCase())) continue;
      seen.add(path.toLowerCase());
      out.push(path);
    }
  }
  return out;
}

export interface CategoryNode {
  name: string;
  label: string;
  depth: number;
  children: CategoryNode[];
}

/** Categories as a tree; siblings keep their order in `categories`. */
export function categoryTree(categories: string[]) {
  const roots: CategoryNode[] = [];
  const nodes = new Map<string, CategoryNode>();
  for (const name of categories) {
    const parent = nodes.get(categoryParent(name).toLowerCase());
    const node: CategoryNode = {
      name,
      label: categoryLeaf(name) || name,
      depth: parent ? parent.depth + 1 : 0,
      children: [],
    };
    nodes.set(name.toLowerCase(), node);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/** Depth-first order, skipping the children of `collapsed` nodes. */
export function flattenCategories(
  roots: CategoryNode[],
  collapsed: (node: CategoryNode) => boolean = () => false,
): CategoryNode[] {
  return roots.flatMap((node) => [
    node,
    ...(collapsed(node) ? [] : flattenCategories(node.children, collapsed)),
  ]);
}

/** Replace `from` (and everything nested in it) with `to` in a key or name. */
function renamePath(item: string, from: string, to: string, prefix = "") {
  if (!item.startsWith(prefix)) return item;
  const name = item.slice(prefix.length);
  if (!withinCategory(name, from)) return item;
  return prefix + to + name.slice(from.length);
}
const insideKey = (item: string, name: string, prefix: string) =>
  item.startsWith(prefix) && withinCategory(item.slice(prefix.length), name);

/** Trim each level of a category path: " ML / Vision " → "ML/Vision". */
export const cleanCategory = (name: string) =>
  name
    .split("/")
    .map((part) => part.trim())
    .join("/");

export const validCategory = (name: string) =>
  name.split("/").every((part) => part.trim().length > 0) &&
  [...name.trim()].length <= 40 &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(name);

export const categoryColors = [
  { value: "#e5534b", label: "红色" },
  { value: "#e8883a", label: "橙色" },
  { value: "#d9a520", label: "黄色" },
  { value: "#4fae6a", label: "绿色" },
  { value: "#3aa7a3", label: "青色" },
  { value: "#4a8fe0", label: "蓝色" },
  { value: "#9a6fdc", label: "紫色" },
  { value: "#d562a6", label: "粉色" },
  { value: "#8a8f98", label: "灰色" },
] as const;
export const MAX_COLOR_CATEGORIES = 9;

/** Color a category, recolor it in place, or remove its color (null). */
export function setCategoryColor(
  prefs: PaperLibraryPreferences,
  name: string,
  color: string | null,
): PaperLibraryPreferences | null {
  const list = prefs.colorCategories || [];
  const at = list.findIndex((item) => item.name === name);
  if (color === null)
    return { ...prefs, colorCategories: list.filter((_, i) => i !== at) };
  if (at >= 0)
    return {
      ...prefs,
      colorCategories: list.map((item, i) =>
        i === at ? { name, color } : item,
      ),
    };
  if (list.length >= MAX_COLOR_CATEGORIES) return null;
  return { ...prefs, colorCategories: [...list, { name, color }] };
}

/** Colors of the colored categories that hold a paper, in key order. */
export function paperColors(
  doc: Pick<Document, "folders">,
  colored: { name: string; color: string }[] = [],
) {
  return colored.filter((item) =>
    doc.folders.some((folder) => withinCategory(folder, item.name)),
  );
}

/** Rename a category and its subcategories in every preference list. */
export function renameCategoryPreferences(
  prefs: PaperLibraryPreferences,
  categories: string[],
  from: string,
  to: string,
): PaperLibraryPreferences {
  const swap = (items?: string[]) =>
    items?.map((item) => renamePath(item, from, to, "folder:"));
  return {
    ...prefs,
    categories: categories.map((name) => renamePath(name, from, to)),
    pinned: swap(prefs.pinned),
    hidden: swap(prefs.hidden),
    collapsed: prefs.collapsed?.map((name) => renamePath(name, from, to)),
    colorCategories: prefs.colorCategories?.map((item) => ({
      ...item,
      name: renamePath(item.name, from, to),
    })),
  };
}

export function removeCategoryPreferences(
  prefs: PaperLibraryPreferences,
  categories: string[],
  name: string,
): PaperLibraryPreferences {
  const drop = (items?: string[]) =>
    items?.filter((item) => !insideKey(item, name, "folder:"));
  return {
    ...prefs,
    categories: categories.filter((item) => !withinCategory(item, name)),
    pinned: drop(prefs.pinned),
    hidden: drop(prefs.hidden),
    collapsed: prefs.collapsed?.filter((item) => !withinCategory(item, name)),
    colorCategories: prefs.colorCategories?.filter(
      (item) => !withinCategory(item.name, name),
    ),
  };
}

/** Swap a category, with its subcategories, and its previous or next sibling. */
export function moveCategory(categories: string[], name: string, by: -1 | 1) {
  const reorder = (nodes: CategoryNode[]): CategoryNode[] => {
    const at = nodes.findIndex((node) => node.name === name);
    if (at < 0)
      return nodes.map((node) => ({
        ...node,
        children: reorder(node.children),
      }));
    const to = at + by;
    if (to < 0 || to >= nodes.length) return nodes;
    const list = [...nodes];
    [list[at], list[to]] = [list[to], list[at]];
    return list;
  };
  return flattenCategories(reorder(categoryTree(categories))).map(
    (node) => node.name,
  );
}

/** Index among siblings and their count, for enabling move up/down. */
export function siblingPosition(categories: string[], name: string) {
  const parent = categoryParent(name).toLowerCase();
  const siblings = categories.filter(
    (item) => categoryParent(item).toLowerCase() === parent,
  );
  return { index: siblings.indexOf(name), count: siblings.length };
}

export function togglePinned(prefs: PaperLibraryPreferences, key: string) {
  const pinned = prefs.pinned || [];
  return {
    ...prefs,
    pinned: pinned.includes(key)
      ? pinned.filter((item) => item !== key)
      : [key, ...pinned],
  };
}

export function setHidden(
  prefs: PaperLibraryPreferences,
  key: string,
  hidden: boolean,
) {
  const items = (prefs.hidden || []).filter((item) => item !== key);
  return { ...prefs, hidden: hidden ? [...items, key] : items };
}

/** Recently opened papers, newest first, excluding pinned ones. */
export function recentPapers(docs: Document[], pinned: string[], limit = 10) {
  return docs
    .filter((doc) => wasOpened(doc) && !pinned.includes(`doc:${doc.id}`))
    .sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
    .slice(0, limit);
}

export { paperYear };

/** Every tag used by the papers, A–Z, keeping the first spelling seen. */
export function paperTags(docs: Pick<Document, "tags">[]) {
  const seen = new Map<string, string>();
  for (const doc of docs)
    for (const tag of doc.tags)
      if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "zh"));
}

/** Save a new or edited smart category; tags are de-duplicated. */
export function saveSmartCategory(
  prefs: PaperLibraryPreferences,
  smart: SmartCategory,
): PaperLibraryPreferences {
  const tags = paperTags([
    { tags: smart.tags.map((t) => t.trim()).filter(Boolean) },
  ]);
  const next = { ...smart, name: smart.name.trim(), tags };
  const list = prefs.smartCategories || [];
  return {
    ...prefs,
    smartCategories: list.some((item) => item.id === smart.id)
      ? list.map((item) => (item.id === smart.id ? next : item))
      : [...list, next],
  };
}

export function removeSmartCategory(
  prefs: PaperLibraryPreferences,
  id: string,
): PaperLibraryPreferences {
  const key = `smart:${id}`;
  return {
    ...prefs,
    smartCategories: prefs.smartCategories?.filter((item) => item.id !== id),
    pinned: prefs.pinned?.filter((item) => item !== key),
    hidden: prefs.hidden?.filter((item) => item !== key),
  };
}
