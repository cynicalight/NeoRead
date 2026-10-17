import { confirmLargePaper } from "../LargePaperDialog";
import { api, RequestError } from "@reader/api";
import type {
  Document,
  PaperLibraryPreferences,
  ReadingStatus,
} from "@reader/core";
import { toast } from "sonner";
import {
  refreshLibrary,
  updateLibraryPreferences,
  useReaderStore,
} from "../store";
import {
  cleanCategory,
  paperCategories,
  removeCategoryPreferences,
  renameCategoryPreferences,
  hasTag,
  validCategory,
  withinCategory,
  type PaperView,
} from "./model";
import { usePaperUI } from "./state";

type Patch = Parameters<typeof api.update>[1];

const papers = () =>
  useReaderStore.getState().documents.filter((d) => d.library === "papers");
const paperPrefs = () =>
  useReaderStore.getState().libraryPreferences.papers || {};

export function savePaperPreferences(
  change: (prefs: PaperLibraryPreferences) => PaperLibraryPreferences,
) {
  return updateLibraryPreferences({ papers: change(paperPrefs()) }).catch((e) =>
    toast.error((e as Error).message),
  );
}

/**
 * Apply patches optimistically, save them one by one, then reload. Failed
 * papers are reported and the reload restores their saved state.
 */
export async function patchPapers(changes: [Document, Patch][]) {
  if (!changes.length) return 0;
  const state = useReaderStore.getState();
  const local = new Map(changes.map(([doc, patch]) => [doc.id, patch]));
  state.setDocuments(
    state.documents.map((doc) =>
      local.has(doc.id)
        ? ({
            ...doc,
            ...local.get(doc.id),
            metadata: { ...doc.metadata, ...local.get(doc.id)!.metadata },
          } as Document)
        : doc,
    ),
  );
  let failed = 0;
  let message = "";
  for (const [doc, patch] of changes) {
    try {
      await api.update(doc.id, patch);
    } catch (e) {
      failed++;
      message = (e as Error).message;
    }
  }
  await refreshLibrary().catch(() => {});
  if (failed) toast.error(`${failed} 篇未能保存：${message}`);
  return changes.length - failed;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const inFolder = (doc: Document, name: string) =>
  doc.folders.some((folder) => same(folder, name));

export function addToCategory(docs: Document[], name: string) {
  return patchPapers(
    docs
      .filter((doc) => !inFolder(doc, name))
      .map((doc) => [doc, { folders: [...doc.folders, name] }]),
  );
}
export function removeFromCategory(docs: Document[], name: string) {
  return patchPapers(
    docs
      .filter((doc) => inFolder(doc, name))
      .map((doc) => [
        doc,
        { folders: doc.folders.filter((folder) => !same(folder, name)) },
      ]),
  );
}
/** Remove the category when every paper is in it, otherwise add all. */
export const toggleCategoryFor = (docs: Document[], name: string) =>
  docs.every((doc) => inFolder(doc, name))
    ? removeFromCategory(docs, name)
    : addToCategory(docs, name);

export function addTag(docs: Document[], name: string) {
  name = name.trim();
  if (!name) return Promise.resolve(0);
  return patchPapers(
    docs
      .filter((doc) => !hasTag(doc, name))
      .map((doc) => [doc, { tags: [...doc.tags, name] }]),
  );
}
export function removeTag(docs: Document[], name: string) {
  return patchPapers(
    docs
      .filter((doc) => hasTag(doc, name))
      .map((doc) => [
        doc,
        { tags: doc.tags.filter((tag) => !same(tag, name)) },
      ]),
  );
}
export const toggleTagFor = (docs: Document[], name: string) =>
  docs.every((doc) => hasTag(doc, name))
    ? removeTag(docs, name)
    : addTag(docs, name);

export const setReadingStatus = (
  docs: Document[],
  readingStatus: ReadingStatus,
) =>
  patchPapers(
    docs
      .filter((doc) => doc.readingStatus !== readingStatus)
      .map((doc) => [doc, { readingStatus }]),
  );
export const setStarred = (docs: Document[], favorite: boolean) =>
  patchPapers(
    docs
      .filter((doc) => doc.favorite !== favorite)
      .map((doc) => [doc, { favorite }]),
  );

const invalidName = "分类名（含上级分类）须为 1–40 个字符";

/** Create a category, optionally placing papers in it. Returns false on bad names. */
export async function createCategory(
  name: string,
  docs: Document[] = [],
  parent = "",
) {
  name = cleanCategory(parent ? `${parent}/${name}` : name);
  if (!validCategory(name)) {
    toast.error(invalidName);
    return false;
  }
  const existing = paperCategories(paperPrefs(), papers()).find(
    (item) => item.toLowerCase() === name.toLowerCase(),
  );
  if (!existing)
    await savePaperPreferences((prefs) => ({
      ...prefs,
      categories: [...paperCategories(prefs, papers()), name],
    }));
  if (docs.length) await addToCategory(docs, existing || name);
  return true;
}

/** Where the current view goes once `from` is renamed (`to`) or deleted. */
function followCategory(from: string, to?: string) {
  const ui = usePaperUI.getState();
  if (!ui.view.startsWith("folder:")) return;
  const current = ui.view.slice(7);
  if (!withinCategory(current, from)) return;
  ui.setView(
    to === undefined
      ? "all"
      : (`folder:${to}${current.slice(from.length)}` as PaperView),
  );
}

/** Rename a category; its subcategories move with it. */
export async function renameCategory(from: string, to: string) {
  to = cleanCategory(to);
  if (to === from) return true;
  if (!validCategory(to)) {
    toast.error(invalidName);
    return false;
  }
  const categories = paperCategories(paperPrefs(), papers());
  if (
    categories.some(
      (item) => item !== from && item.toLowerCase() === to.toLowerCase(),
    )
  ) {
    toast.error(`已有名为“${to}”的分类`);
    return false;
  }
  try {
    await api.changeLibraryFolder("papers", from, to);
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
  await savePaperPreferences((prefs) =>
    renameCategoryPreferences(prefs, categories, from, to),
  );
  followCategory(from, to);
  await refreshLibrary().catch(() => {});
  return true;
}

/** Delete a category and its subcategories; their papers stay. */
export async function deleteCategory(name: string) {
  const categories = paperCategories(paperPrefs(), papers());
  try {
    await api.changeLibraryFolder("papers", name);
  } catch (e) {
    toast.error((e as Error).message);
    return;
  }
  await savePaperPreferences((prefs) =>
    removeCategoryPreferences(prefs, categories, name),
  );
  followCategory(name);
  await refreshLibrary().catch(() => {});
}

export function openLink(url: string) {
  if (!url) return;
  if (window.readerDesktop?.openExternal)
    void window.readerDesktop
      .openExternal(url)
      .catch((e) => toast.error((e as Error).message));
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function revealFile(doc: Document, open = false) {
  const desktop = window.readerDesktop;
  if (!desktop?.showDocumentFile) {
    toast.info("请在桌面版中打开文件");
    return;
  }
  void (open ? desktop.openDocumentFile : desktop.showDocumentFile)(
    doc.id,
    doc.type,
  ).catch((e) => toast.error((e as Error).message));
}

const referencePattern =
  /^(?:https?:\/\/\S+|(?:arxiv:\s*)?\d{4}\.\d{4,5}(?:v\d+)?|(?:doi:\s*)?10\.\d{4,9}\/\S+)$/i;
/** A pasted arXiv ID, DOI or link; plain titles are only imported on request. */
export const looksLikeReference = (text: string) =>
  text.length <= 500 && referencePattern.test(text.trim());

/** Download a paper by identifier, link or title and show it in the list. */
export async function importReference(ref: string) {
  let doc;
  try {
    doc = await api.resolveDocument(ref.trim());
  } catch (error) {
    if (!(error instanceof RequestError) || error.code !== "large-paper")
      throw error;
    const library = await confirmLargePaper();
    if (!library) throw new Error("已取消导入");
    doc = await api.resolveDocument(ref.trim(), { library, allowLarge: true });
  }
  await refreshLibrary().catch(() => {});
  const ui = usePaperUI.getState();
  if (doc.library === "papers") {
    ui.setView("all");
    ui.setQuery("");
    ui.select(doc.id);
  }
  return doc;
}

export async function lookupPaper(doc: Document) {
  try {
    await api.lookupMetadata(doc.id);
    await refreshLibrary().catch(() => {});
    toast.success("已更新论文信息");
  } catch (e) {
    toast.error((e as Error).message);
  }
}
