import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckSquare,
  Columns3,
  List,
  Table2,
  FolderMinus,
  FolderPlus,
  Loader2,
  Languages,
  Merge,
  MoreHorizontal,
  Tag,
  PanelLeft,
  Search,
  Star,
  StickyNote,
  Highlighter,
  CircleHelp,
  Quote,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@reader/api";
import type {
  Document,
  JournalRankConfig,
  PaperColumn,
  PaperSort,
  Processing,
  ReadingStatus,
} from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Checkbox } from "@reader/ui/components/checkbox";
import { Input } from "@reader/ui/components/input";
import { Progress } from "@reader/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@reader/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@reader/ui/components/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@reader/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@reader/ui/components/dropdown-menu";
import { useReaderStore } from "../store";
import { TrashView } from "../TrashView";
import { trashWithUndo } from "../library-actions";
import { toast } from "sonner";
import {
  addToCategory,
  createCategory,
  importReference,
  looksLikeReference,
  addTag,
  removeFromCategory,
  savePaperPreferences,
  toggleTagFor,
  toggleCategoryFor,
  setReadingStatus,
  setStarred,
} from "./actions";
import {
  authorsShort,
  paperByline,
  paperYear,
  relativeTime,
  venueLabel,
  wasOpened,
} from "./format";
import {
  categoryTree,
  columnLabels,
  columnSort,
  defaultColumns,
  descendingSorts,
  duplicateGroups,
  filterPapers,
  flattenCategories,
  hasTag,
  pairKey,
  paperCategories,
  paperTags,
  saveSmartCategory,
  paperColors,
  sortLabels,
  statusLabels,
  toggleColumn,
  viewLabels,
  type BuiltinView,
} from "./model";
import { usePaperUI } from "./state";
import { PaperDetail } from "./PaperDetail";
import { PaperMenuItems, type PaperMenuActions } from "./PaperMenu";
import { CategoryDialog } from "./CategoryDialog";
import { CitationDialog } from "./CitationDialog";
import { MergeDialog } from "./MergeDialog";
import { SmartCategoryDialog } from "./SmartCategoryDialog";
import { copyCitations, exportCitations } from "./CitationMenu";
import { PAPER_DRAG_TYPE } from "./PaperSidebar";
import { JournalRankBadges } from "./JournalRankBadges";
import {
  clampDetailWidth,
  detailWidthRange,
  dragHorizontally,
  resizeBoundary,
  resizeStep,
} from "./resize";

export interface PaperLibraryProps {
  documents: Document[];
  trash: Document[];
  jobs: Map<string, Processing>;
  loading: boolean;
  openDocument: (doc: Document) => void;
  moveToBooks: (doc: Document) => void;
  navOpen: boolean;
  onToggleNav: () => void;
}

const busy = (job?: Processing) =>
  !!job && !["complete", "failed"].includes(job.status);

export function PaperLibrary({
  documents,
  trash,
  jobs,
  loading,
  openDocument,
  moveToBooks,
  navOpen,
  onToggleNav,
}: PaperLibraryProps) {
  const prefs = useReaderStore((s) => s.libraryPreferences.papers) || {};
  const sort: PaperSort = prefs.sort || "opened";
  const reverse = !!prefs.sortReverse;
  const columns = prefs.columns || defaultColumns;
  const ui = usePaperUI();
  const { view, query, selectedId, picking, picked, naming, exporting } = ui;
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () =>
      view === "trash"
        ? []
        : filterPapers(documents, view, query, sort, jobs, {
            subcategories: prefs.subcategoryItems !== false,
            smart: prefs.smartCategories,
            notDuplicates: prefs.notDuplicates,
            reverse,
          }),
    [
      documents,
      view,
      query,
      sort,
      jobs,
      prefs.subcategoryItems,
      prefs.smartCategories,
      prefs.notDuplicates,
      reverse,
    ],
  );
  const [merging, setMerging] = useState<Document[] | null>(null);
  const [tagging, setTagging] = useState<string[] | null>(null);
  const [journalRankConfig, setJournalRankConfig] =
    useState<JournalRankConfig | null>(null);
  const [journalRankRefresh, setJournalRankRefresh] = useState(0);
  useEffect(() => {
    let mounted = true;
    const load = () =>
      void api
        .journalRankConfig()
        .then((value) => {
          if (mounted) setJournalRankConfig(value);
        })
        .catch(() => {});
    const refresh = () => setJournalRankRefresh((value) => value + 1);
    load();
    window.addEventListener("reader:journal-rank-config", load);
    window.addEventListener("reader:journal-rank-refresh", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("reader:journal-rank-config", load);
      window.removeEventListener("reader:journal-rank-refresh", refresh);
    };
  }, []);
  const tags = paperTags(documents);
  const table = prefs.layout === "table" && view !== "duplicates";
  const sortBy = (next: PaperSort) =>
    void savePaperPreferences((p) => ({
      ...p,
      sort: next,
      sortReverse: (p.sort || "opened") === next ? !p.sortReverse : false,
    }));
  const groups = useMemo(() => {
    if (view !== "duplicates") return [];
    const shown = new Set(visible.map((d) => d.id));
    return duplicateGroups(documents, prefs.notDuplicates)
      .map((group) => group.filter((d) => shown.has(d.id)))
      .filter((group) => group.length > 0);
  }, [view, visible, documents, prefs.notDuplicates]);
  const visibleIds = visible.map((d) => d.id);
  const selected = documents.find((d) => d.id === selectedId);
  const pickedDocs = documents.filter((d) => picked.has(d.id));
  const categories = paperCategories(prefs, documents);
  const category = view.startsWith("folder:") ? view.slice(7) : "";
  const smart = prefs.smartCategories || [];
  const title =
    view === "trash"
      ? "回收站"
      : view.startsWith("tag:")
        ? `#${view.slice(4)}`
        : view.startsWith("smart:")
          ? smart.find((s) => `smart:${s.id}` === view)?.name || "智能标签分类"
          : category.replaceAll("/", " / ") ||
            viewLabels[view as BuiltinView] ||
            "全部论文";
  useEffect(() => {
    // Pasting an arXiv ID, DOI or link anywhere outside a field imports it.
    const paste = (e: ClipboardEvent) => {
      const target = e.target as Element | null;
      if (
        target?.closest?.(
          'input, textarea, [contenteditable="true"], [role="dialog"]',
        )
      )
        return;
      const text = e.clipboardData?.getData("text/plain")?.trim() || "";
      if (!looksLikeReference(text)) return;
      e.preventDefault();
      const id = toast.loading("正在查找并下载论文…");
      void importReference(text)
        .then((doc) =>
          toast.success(
            doc.library === "papers"
              ? `已导入《${doc.title}》`
              : "这篇论文已在图书库中，可在那里移动",
            { id },
          ),
        )
        .catch((error) => toast.error((error as Error).message, { id }));
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);
  useEffect(() => {
    // ⌘⇧C copies the selected papers in the last used citation format.
    const key = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        !e.shiftKey ||
        e.key.toLowerCase() !== "c" ||
        (e.target as Element | null)?.closest?.("input, textarea")
      )
        return;
      const state = usePaperUI.getState();
      const all = useReaderStore.getState().documents;
      const targets = state.picking
        ? all.filter((d) => state.picked.has(d.id))
        : all.filter((d) => d.id === state.selectedId);
      if (!targets.length) return;
      e.preventDefault();
      void copyCitations(
        targets,
        useReaderStore.getState().libraryPreferences.papers?.citationStyle ||
          "gb7714",
      );
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    // A paper that left the library (trash, move) cannot stay selected.
    if (selectedId && !selected) ui.select(null);
  }, [selectedId, selected, ui]);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // Pressing on empty library space closes the detail panel.
    const main = mainRef.current;
    if (!main || !selectedId) return;
    const away = (e: PointerEvent) => {
      if (
        e.button === 0 &&
        !(e.target as Element).closest(
          '[data-paper-id], .paper-detail, button, a, input, textarea, select, label, [role="button"], [role="separator"], [role="tab"], [contenteditable="true"]',
        )
      )
        ui.select(null);
    };
    main.addEventListener("pointerdown", away);
    return () => main.removeEventListener("pointerdown", away);
  }, [selectedId, ui]);
  // Widths follow the pointer locally and are saved once the drag ends.
  const [draftWidths, setDraftWidths] =
    useState<Partial<Record<PaperColumn, number>>>();
  const [draftDetail, setDraftDetail] = useState<number>();
  const columnWidths = { ...prefs.columnWidths, ...draftWidths };
  const detailWidth = draftDetail ?? prefs.detailWidth;
  const saveColumnWidths = (next: Partial<Record<PaperColumn, number>>) =>
    void savePaperPreferences((p) => ({
      ...p,
      columnWidths: { ...p.columnWidths, ...next },
    }));
  const headerWidths = (cell: Element) =>
    Object.fromEntries(
      Array.from(
        cell.closest("tr")?.querySelectorAll<HTMLElement>("th[data-column]") ??
          [],
      ).map((th) => [th.dataset.column, th.getBoundingClientRect().width]),
    );
  const resizeColumn = (
    e: ReactPointerEvent<HTMLElement>,
    left: "title" | PaperColumn,
    right: PaperColumn,
  ) => {
    const start = headerWidths(e.currentTarget);
    let next: Partial<Record<PaperColumn, number>> = {};
    dragHorizontally(
      e,
      (dx) => {
        next = resizeBoundary(start, left, right, dx);
        setDraftWidths(next);
      },
      () => {
        if (Object.keys(next).length) saveColumnWidths(next);
        setDraftWidths(undefined);
      },
    );
  };
  const nudgeColumn = (
    e: ReactKeyboardEvent<HTMLElement>,
    left: "title" | PaperColumn,
    right: PaperColumn,
  ) => {
    const dx = { ArrowLeft: -resizeStep, ArrowRight: resizeStep }[e.key];
    if (!dx) return;
    e.preventDefault();
    saveColumnWidths(
      resizeBoundary(headerWidths(e.currentTarget), left, right, dx),
    );
  };
  const saveDetailWidth = (width: number) =>
    void savePaperPreferences((p) => ({ ...p, detailWidth: width }));
  const resizeDetail = (e: ReactPointerEvent<HTMLElement>) => {
    const start =
      e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? 0;
    let width: number | undefined;
    dragHorizontally(
      e,
      // The panel sits on the right: dragging left widens it.
      (dx) => setDraftDetail((width = clampDetailWidth(start - dx))),
      () => {
        if (width !== undefined) saveDetailWidth(width);
        setDraftDetail(undefined);
      },
    );
  };
  const nudgeDetail = (e: ReactKeyboardEvent<HTMLElement>) => {
    const dx = { ArrowLeft: resizeStep, ArrowRight: -resizeStep }[e.key];
    if (!dx) return;
    e.preventDefault();
    const current =
      e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? 0;
    saveDetailWidth(clampDetailWidth(current + dx));
  };
  const trashPapers = async (docs: Document[], exitPicking: boolean) => {
    const result = await trashWithUndo(docs.map((d) => d.id));
    const state = usePaperUI.getState();
    if (exitPicking && !result.failed.length) state.stopPicking();
    else
      state.setPicked(
        [...state.picked].filter((id) => !result.deleted.includes(id)),
      );
    return result;
  };
  const actions: PaperMenuActions = {
    open: openDocument,
    move: moveToBooks,
    trash: (docs) => {
      const state = usePaperUI.getState();
      const selectedBatch =
        state.picking &&
        docs.length > 0 &&
        docs.length === state.picked.size &&
        docs.every((doc) => state.picked.has(doc.id));
      void trashPapers(docs, selectedBatch);
    },
    newCategory: (docs) => ui.setNaming(docs.map((d) => d.id)),
    newTag: (docs) => setTagging(docs.map((d) => d.id)),
  };
  const menuDocs = (doc: Document) =>
    picking && picked.has(doc.id) ? pickedDocs : [doc];
  const allPicked =
    visible.length > 0 && visible.every((d) => picked.has(d.id));
  const focusRow = (id: string) =>
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-paper-id="${id}"]`)
        ?.focus(),
    );
  const onListKey = (e: React.KeyboardEvent) => {
    if ((e.target as Element).closest("input, textarea, [role=menu]")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      ui.startPicking(visibleIds);
      return;
    }
    if (e.key === "Escape") {
      if (picking) ui.stopPicking();
      else ui.select(null);
      return;
    }
    // Number keys toggle the colored category in that position.
    const colored = prefs.colorCategories?.[Number(e.key) - 1];
    if (
      /^[1-9]$/.test(e.key) &&
      colored &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const targets = picking ? pickedDocs : selected ? [selected] : [];
      if (!targets.length) return;
      e.preventDefault();
      void toggleCategoryFor(targets, colored.name);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const index = visibleIds.indexOf(
        (document.activeElement as HTMLElement)?.dataset.paperId ||
          selectedId ||
          "",
      );
      const next =
        visibleIds[
          Math.max(
            0,
            Math.min(
              visibleIds.length - 1,
              index + (e.key === "ArrowDown" ? 1 : -1),
            ),
          )
        ];
      if (next) {
        if (!picking) ui.select(next);
        focusRow(next);
      }
    }
  };
  const renderRow = (doc: Document, tableColumns?: PaperColumn[]) => (
    <PaperRow
      columns={tableColumns}
      key={doc.id}
      doc={doc}
      job={jobs.get(doc.id)}
      selected={!picking && selectedId === doc.id}
      picking={picking}
      picked={picked.has(doc.id)}
      colors={paperColors(doc, prefs.colorCategories)}
      journalRankConfig={journalRankConfig}
      journalRankRefresh={journalRankRefresh}
      dragIds={() => (picked.has(doc.id) ? [...picked] : [doc.id])}
      onActivate={(e) => {
        if (picking || e.metaKey || e.ctrlKey || e.shiftKey)
          ui.togglePick(doc.id, e.shiftKey, visibleIds);
        else ui.select(selectedId === doc.id ? null : doc.id);
      }}
      onOpen={() => openDocument(doc)}
      menu={
        <PaperMenuItems kind="context" docs={menuDocs(doc)} actions={actions} />
      }
      moreMenu={
        <PaperMenuItems
          kind="dropdown"
          docs={menuDocs(doc)}
          actions={actions}
        />
      }
    />
  );
  return (
    <main className="library-main paper-library" ref={mainRef}>
      <header className="library-topbar">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="切换侧栏"
            aria-expanded={navOpen}
            onClick={onToggleNav}
          >
            <PanelLeft />
          </Button>
          <h1 className="library-title truncate">{title}</h1>
          {view !== "trash" && (
            <span className="text-xs text-muted-foreground">
              {visible.length}
            </span>
          )}
        </div>
        {view !== "trash" && (
          <div className="flex items-center gap-2">
            <div className="search-field paper-search">
              <Search className="size-4" />
              <Input
                aria-label="搜索论文"
                placeholder="标题、作者、出处、DOI、摘要…"
                value={query}
                onChange={(e) => ui.setQuery(e.target.value)}
              />
            </div>
            <Select
              value={sort}
              onValueChange={(value) => {
                if (value)
                  void savePaperPreferences((p) => ({
                    ...p,
                    sort: value as PaperSort,
                    sortReverse: false,
                  }));
              }}
            >
              <SelectTrigger size="sm" aria-label="排序">
                <SelectValue>{sortLabels[sort]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(sortLabels) as PaperSort[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {sortLabels[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {table && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="显示的列"
                      title="显示的列"
                    />
                  }
                >
                  <Columns3 />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {(Object.keys(columnLabels) as PaperColumn[]).map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c}
                      checked={columns.includes(c)}
                      onCheckedChange={() =>
                        void savePaperPreferences((p) => ({
                          ...p,
                          columns: toggleColumn(p.columns || defaultColumns, c),
                        }))
                      }
                    >
                      {columnLabels[c]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Tabs
              value={prefs.layout || "list"}
              onValueChange={(value) =>
                void savePaperPreferences((p) => ({
                  ...p,
                  layout: value as "list" | "table",
                }))
              }
            >
              <TabsList aria-label="显示方式">
                <TabsTrigger value="table" aria-label="表格" title="表格">
                  <Table2 />
                </TabsTrigger>
                <TabsTrigger value="list" aria-label="列表" title="列表">
                  <List />
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              size="sm"
              variant={picking ? "secondary" : "outline"}
              aria-pressed={picking}
              disabled={!visible.length && !picking}
              onClick={() => (picking ? ui.stopPicking() : ui.startPicking())}
            >
              {picking ? <Check /> : <CheckSquare />}
              {picking ? "完成" : "批量"}
            </Button>
          </div>
        )}
      </header>
      {view === "trash" ? (
        <div className="library-content">
          <TrashView documents={trash} />
        </div>
      ) : (
        <div
          className="paper-library-body"
          style={
            detailWidth
              ? ({
                  "--paper-detail-width": `${detailWidth}px`,
                } as CSSProperties)
              : undefined
          }
        >
          <section
            className="paper-list-pane"
            aria-label="论文列表"
            onKeyDown={onListKey}
          >
            {picking && (
              <div
                className="paper-batch-bar"
                role="toolbar"
                aria-label="批量操作"
              >
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={allPicked}
                    indeterminate={picked.size > 0 && !allPicked}
                    onCheckedChange={() =>
                      allPicked
                        ? ui.setPicked(
                            [...picked].filter(
                              (id) => !visibleIds.includes(id),
                            ),
                          )
                        : ui.setPicked([...picked, ...visibleIds])
                    }
                  />
                  全选
                </label>
                <span className="text-sm text-muted-foreground" role="status">
                  已选 {picked.size} 篇
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!pickedDocs.length}
                        />
                      }
                    >
                      <FolderPlus />
                      加入分类
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-80 w-48">
                      {flattenCategories(categoryTree(categories)).map(
                        (node) => (
                          <DropdownMenuItem
                            key={node.name}
                            onClick={() =>
                              void addToCategory(pickedDocs, node.name)
                            }
                          >
                            <span
                              className="truncate"
                              style={{ paddingLeft: node.depth * 12 }}
                            >
                              {node.label}
                            </span>
                          </DropdownMenuItem>
                        ),
                      )}
                      {categories.length > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onClick={() => actions.newCategory(pickedDocs)}
                      >
                        <FolderPlus />
                        新建分类并放入…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {category && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!pickedDocs.length}
                      onClick={() =>
                        void removeFromCategory(pickedDocs, category)
                      }
                    >
                      <FolderMinus />
                      移出当前分类
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!pickedDocs.length}
                        />
                      }
                    >
                      阅读状态
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {(Object.keys(statusLabels) as ReadingStatus[]).map(
                        (key) => (
                          <DropdownMenuItem
                            key={key}
                            onClick={() =>
                              void setReadingStatus(pickedDocs, key)
                            }
                          >
                            标为{statusLabels[key]}
                          </DropdownMenuItem>
                        ),
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!pickedDocs.length}
                    onClick={() =>
                      void setStarred(
                        pickedDocs,
                        !pickedDocs.every((d) => d.favorite),
                      )
                    }
                  >
                    <Star />
                    星标
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!pickedDocs.length}
                    onClick={() =>
                      exportCitations(pickedDocs, `${pickedDocs.length} 篇论文`)
                    }
                  >
                    <Quote />
                    导出引用
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!pickedDocs.length}
                        />
                      }
                    >
                      <Tag />
                      标签
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-80 w-48">
                      {tags.map((tag) => (
                        <DropdownMenuCheckboxItem
                          key={tag}
                          checked={pickedDocs.every((d) => hasTag(d, tag))}
                          onCheckedChange={() =>
                            void toggleTagFor(pickedDocs, tag)
                          }
                        >
                          <span className="truncate">#{tag}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                      {tags.length > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onClick={() => actions.newTag(pickedDocs)}
                      >
                        <Tag />
                        新标签…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={!pickedDocs.length}
                    onClick={() => void trashPapers(pickedDocs, true)}
                  >
                    <Trash2 />
                    移到回收站
                  </Button>
                </div>
              </div>
            )}
            {loading ? (
              <div className="empty-state">
                <Loader2 className="animate-spin text-muted-foreground" />
              </div>
            ) : visible.length ? (
              view === "duplicates" ? (
                <div className="paper-list" ref={listRef}>
                  {groups.map((group) => (
                    <section
                      key={group[0].id}
                      className="paper-duplicate-group"
                      aria-label={`${group.length} 个版本`}
                    >
                      <header className="paper-duplicate-head">
                        <span>{group.length} 个版本</span>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void savePaperPreferences((p) => ({
                              ...p,
                              notDuplicates: [
                                ...new Set([
                                  ...(p.notDuplicates || []),
                                  ...group.flatMap((a, x) =>
                                    group
                                      .slice(x + 1)
                                      .map((b) => pairKey(a.id, b.id)),
                                  ),
                                ]),
                              ],
                            }))
                          }
                        >
                          不是重复
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={group.length < 2}
                          onClick={() => setMerging(group)}
                        >
                          <Merge />
                          合并…
                        </Button>
                      </header>
                      <div role="list">
                        {group.map((doc) => renderRow(doc))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : table ? (
                <div className="paper-list paper-table" ref={listRef}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {picking && <TableHead className="w-8" />}
                        {(["title", ...columns] as const).map((c, i, order) => {
                          const next = order[i + 1] as PaperColumn | undefined;
                          const active = sort === columnSort[c];
                          const descending =
                            descendingSorts.has(sort) !== reverse;
                          const Arrow = descending ? ArrowDown : ArrowUp;
                          return (
                            <TableHead
                              key={c}
                              data-column={c}
                              style={
                                c === "title"
                                  ? undefined
                                  : { width: columnWidths[c] }
                              }
                              aria-sort={
                                active
                                  ? descending
                                    ? "descending"
                                    : "ascending"
                                  : undefined
                              }
                            >
                              <Button
                                size="xs"
                                variant="ghost"
                                className="paper-table-sort"
                                onClick={() => sortBy(columnSort[c])}
                              >
                                {c === "title" ? "标题" : columnLabels[c]}
                                {active && <Arrow />}
                              </Button>
                              {/* The last column borders the menu column; the title absorbs its changes. */}
                              {next && (
                                <span
                                  role="separator"
                                  aria-orientation="vertical"
                                  aria-label={`调整${c === "title" ? "标题" : columnLabels[c]}列宽度`}
                                  tabIndex={0}
                                  className="paper-column-resizer"
                                  onPointerDown={(e) =>
                                    resizeColumn(e, c, next)
                                  }
                                  onKeyDown={(e) => nudgeColumn(e, c, next)}
                                />
                              )}
                            </TableHead>
                          );
                        })}
                        <TableHead className="w-8" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((doc) => renderRow(doc, columns))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="paper-list" ref={listRef} role="list">
                  {visible.map((doc) => renderRow(doc))}
                </div>
              )
            ) : (
              <div className="empty-state">
                <h2>{documents.length ? "没有符合条件的论文" : "暂无论文"}</h2>
                {documents.length > 0 && (query || view !== "all") && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      ui.setQuery("");
                      ui.setView("all");
                    }}
                  >
                    显示全部论文
                  </Button>
                )}
              </div>
            )}
          </section>
          {selected && !picking && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整论文详情宽度"
                aria-valuemin={detailWidthRange.min}
                aria-valuemax={detailWidthRange.max}
                aria-valuenow={detailWidth}
                tabIndex={0}
                className="paper-detail-resizer"
                onPointerDown={resizeDetail}
                onKeyDown={nudgeDetail}
              />
              <PaperDetail key={selected.id} doc={selected} actions={actions} />
            </>
          )}
        </div>
      )}
      {exporting && (
        <CitationDialog
          docs={documents.filter((d) => exporting.ids.includes(d.id))}
          title={exporting.title}
          onClose={() => ui.setExporting(null)}
          onEdit={(doc) => {
            ui.setExporting(null);
            ui.stopPicking();
            ui.setView("all");
            ui.setQuery("");
            ui.select(doc.id);
          }}
        />
      )}
      {tagging && (
        <CategoryDialog
          kind="tag"
          count={tagging.length}
          onClose={() => setTagging(null)}
          onSave={async (name) => {
            const tag = name.trim().replace(/^#/, "");
            if (!tag || [...tag].length > 40) {
              toast.error("标签须为 1–40 个字符");
              return false;
            }
            await addTag(
              documents.filter((d) => tagging.includes(d.id)),
              tag,
            );
            return true;
          }}
        />
      )}
      {ui.smartEditing && (
        <SmartCategoryDialog
          smart={ui.smartEditing}
          isNew={!smart.some((s) => s.id === ui.smartEditing!.id)}
          tags={tags}
          onClose={() => ui.setSmartEditing(null)}
          onSave={(next) => {
            void savePaperPreferences((p) => saveSmartCategory(p, next));
            ui.setView(`smart:${next.id}`);
          }}
        />
      )}
      {merging && (
        <MergeDialog group={merging} onClose={() => setMerging(null)} />
      )}
      {naming && (
        <CategoryDialog
          count={naming.length}
          parent={ui.namingParent}
          onClose={() => ui.setNaming(null)}
          onSave={(name) =>
            createCategory(
              name,
              documents.filter((d) => naming.includes(d.id)),
              ui.namingParent,
            )
          }
        />
      )}
    </main>
  );
}

function PaperProcessing({ job }: { job?: Processing }) {
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(false);
  useEffect(() => {
    retryLock.current = false;
    setRetrying(false);
  }, [job?.updatedAt]);
  if (job?.manualTranslation && !job.enabled && job.phase !== "learning") {
    return (
      <Button
        size="xs"
        variant="ghost"
        data-row-action
        disabled={retrying}
        onClick={async (event) => {
          event.stopPropagation();
          if (retryLock.current) return;
          retryLock.current = true;
          setRetrying(true);
          try {
            await api.setAssistance(job.documentId, "start");
          } catch (error) {
            retryLock.current = false;
            setRetrying(false);
            toast.error((error as Error).message);
          }
        }}
      >
        <Languages className="size-3" />
        翻译
      </Button>
    );
  }
  if (
    !job ||
    job.enabled === false ||
    job.status === "paused" ||
    job.phase === "ready" ||
    job.status === "complete"
  )
    return null;
  const parsing = job.phase === "learning";
  const status = parsing ? job.status : (job.translating?.status ?? job.status);
  const name = parsing ? "解析" : "翻译";
  const label =
    status === "queued"
      ? `等待${name}`
      : status === "waiting"
        ? "等待 AI 配置"
        : status === "failed"
          ? `${name}失败`
          : `${name}中`;
  const done = parsing ? job.pagesDone : job.translationsDone;
  const total = parsing ? job.pagesTotal : job.translationsTotal;
  const value =
    total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : null;
  const retry = async () => {
    if (retryLock.current) return;
    retryLock.current = true;
    setRetrying(true);
    try {
      await api.process(job.documentId);
      // Keep disabled until polling receives the updated task.
    } catch (error) {
      retryLock.current = false;
      setRetrying(false);
      toast.error((error as Error).message);
    }
  };
  return (
    <span className="paper-title-processing" role="status">
      <span>{label}</span>
      <Progress
        aria-label={`${name}进度`}
        value={value}
        className="processing-progress"
      />
      {status === "failed" && (
        <Button
          size="xs"
          variant="ghost"
          aria-label={`重试${name}`}
          data-row-action
          disabled={retrying}
          onClick={(event) => {
            event.stopPropagation();
            void retry();
          }}
        >
          <RefreshCw className="size-3" />
          {retrying ? "重试中" : "重试"}
        </Button>
      )}
    </span>
  );
}

function PaperRow({
  doc,
  job,
  selected,
  picking,
  picked,
  colors,
  journalRankConfig,
  journalRankRefresh,
  columns,
  dragIds,
  onActivate,
  onOpen,
  menu,
  moreMenu,
}: {
  doc: Document;
  job?: Processing;
  selected: boolean;
  picking: boolean;
  picked: boolean;
  colors: { name: string; color: string }[];
  journalRankConfig: JournalRankConfig | null;
  journalRankRefresh: number;
  /** Table columns; the row renders as a list card without them. */
  columns?: PaperColumn[];
  dragIds: () => string[];
  onActivate: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onOpen: () => void;
  menu: React.ReactNode;
  moreMenu: React.ReactNode;
}) {
  const byline = paperByline(doc);
  const percent = Math.round(doc.percentage * 100);
  const check = picking && (
    <span className="paper-row-check" data-row-action>
      <Checkbox
        checked={picked}
        aria-label={`选择 ${doc.title}`}
        onCheckedChange={() => onActivate({} as React.MouseEvent)}
      />
    </span>
  );
  const title = (
    <p className="paper-row-title" title={doc.title}>
      {colors.length > 0 && (
        <span
          className="paper-row-colors"
          role="img"
          aria-label={colors.map((c) => c.name).join("、")}
          title={colors.map((c) => c.name).join("、")}
        >
          {colors.map((c) => (
            <span
              key={c.name}
              className="color-dot"
              style={{ background: c.color }}
            />
          ))}
        </span>
      )}
      {doc.favorite && (
        <Star className="mr-1 inline size-3 fill-current text-amber-500" />
      )}
      {doc.title}
    </p>
  );
  const status = (
    <span className="paper-row-status" data-status={doc.readingStatus}>
      {doc.readingStatus === "reading" && percent > 0
        ? `${percent}%`
        : statusLabels[doc.readingStatus]}
    </span>
  );
  const counts = (
    <>
      {!columns && <PaperProcessing job={job} />}
      {doc.noteCount > 0 && (
        <span title={`${doc.noteCount} 条批注`}>
          <StickyNote className="size-3" />
          {doc.noteCount}
        </span>
      )}
      {doc.openQuestionCount > 0 && (
        <span title={`${doc.openQuestionCount} 个问题待回答`}>
          <CircleHelp className="size-3" />
          {doc.openQuestionCount}
        </span>
      )}
      {doc.highlightCount > 0 && (
        <span title={`${doc.highlightCount} 处划线`}>
          <Highlighter className="size-3" />
          {doc.highlightCount}
        </span>
      )}
    </>
  );
  const more = (
    <span data-row-action>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="paper-row-more"
              aria-label={`${doc.title} 的更多操作`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {moreMenu}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
  const cell = (column: PaperColumn) => {
    switch (column) {
      case "authors":
        return authorsShort(doc, 2);
      case "year":
        return paperYear(doc.metadata);
      case "venue":
        return venueLabel(doc.metadata);
      case "added":
        return new Date(doc.createdAt).toLocaleDateString("zh-CN");
      case "opened":
        return wasOpened(doc) ? relativeTime(doc.lastOpenedAt) : "";
      case "notes":
        return <span className="paper-row-meta">{counts}</span>;
      case "status":
        return status;
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={columns ? <tr /> : <article />}
        role={columns ? undefined : "listitem"}
        className={columns ? "paper-table-row" : "paper-row"}
        data-paper-id={doc.id}
        data-selected={selected || undefined}
        data-picked={picked || undefined}
        tabIndex={0}
        draggable
        aria-label={doc.title}
        onDragStart={(e) => {
          e.dataTransfer.setData(PAPER_DRAG_TYPE, JSON.stringify(dragIds()));
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={(e) => {
          if ((e.target as Element).closest("[data-row-action]")) return;
          onActivate(e);
        }}
        onDoubleClick={(e) => {
          if ((e.target as Element).closest("[data-row-action]")) return;
          if (!picking) onOpen();
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter") {
            e.preventDefault();
            if (picking) onActivate(e);
            else onOpen();
          }
          if (e.key === " ") {
            e.preventDefault();
            onActivate(e);
          }
        }}
      >
        {columns ? (
          <>
            {picking && <TableCell className="w-8">{check}</TableCell>}
            <TableCell className="paper-table-title">
              <div className="paper-table-title-stack">
                <div className="paper-table-title-content">
                  {title}
                  <PaperProcessing job={job} />
                </div>
                <JournalRankBadges
                  id={doc.id}
                  venue={doc.metadata.venue || ""}
                  config={journalRankConfig}
                  refreshRevision={journalRankRefresh}
                />
              </div>
            </TableCell>
            {columns.map((column) => (
              <TableCell key={column} data-column={column}>
                {cell(column)}
              </TableCell>
            ))}
            <TableCell className="w-8">{more}</TableCell>
          </>
        ) : (
          <>
            {check}
            <div className="paper-row-main">
              {title}
              {byline && (
                <p className="paper-row-byline" title={byline}>
                  {byline}
                </p>
              )}
              <JournalRankBadges
                id={doc.id}
                venue={doc.metadata.venue || ""}
                config={journalRankConfig}
                refreshRevision={journalRankRefresh}
              />
            </div>
            <div className="paper-row-meta">
              {counts}
              {status}
            </div>
            {more}
          </>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}
