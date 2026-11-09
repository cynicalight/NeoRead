import { useEffect, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleHelp,
  Copy,
  Eye,
  FileDown,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Tags,
  Library,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import type {
  Document,
  Processing,
  ReadingStatus,
  SmartCategory,
} from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@neoread/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@neoread/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@neoread/ui/components/alert-dialog";
import { useReaderStore } from "../store";
import {
  addToCategory,
  deleteCategory,
  renameCategory,
  savePaperPreferences,
  setReadingStatus,
  setStarred,
} from "./actions";
import { toast } from "sonner";
import { shortTitle } from "./format";
import {
  categoryColors,
  categoryLeaf,
  categoryParent,
  categoryTree,
  duplicateGroups,
  flattenCategories,
  managedViews,
  matchesView,
  moveCategory,
  paperCategories,
  recentPapers,
  removeSmartCategory,
  MAX_COLOR_CATEGORIES,
  setCategoryColor,
  setHidden,
  siblingPosition,
  togglePinned,
  viewLabels,
  withinCategory,
  type BuiltinView,
  type CategoryNode,
  type PaperView,
} from "./model";
import { usePaperUI } from "./state";
import { exportCitations } from "./CitationMenu";

/** Drag payload for papers moved onto sidebar targets. */
export const PAPER_DRAG_TYPE = "application/x-neoread-papers";

const viewIcons: Record<BuiltinView, typeof Library> = {
  all: Library,
  reading: BookOpen,
  unread: Circle,
  done: CheckCircle2,
  starred: Star,
  processing: Loader2,
  questions: CircleHelp,
  unfiled: Inbox,
  duplicates: Copy,
};

/** True while ⌥ is held, to show the categories of the selected paper. */
function useAltKey() {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => setDown(e.altKey);
    const up = () => setDown(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", up);
    };
  }, []);
  return down;
}

function droppedIds(e: React.DragEvent) {
  try {
    const ids: unknown = JSON.parse(e.dataTransfer.getData(PAPER_DRAG_TYPE));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function SidebarRow({
  icon: Icon,
  label,
  count,
  active,
  pinned,
  onSelect,
  onDrop,
  menu,
  title,
  highlighted,
  color,
}: {
  icon: typeof Library;
  label: string;
  count?: number;
  active?: boolean;
  pinned?: boolean;
  onSelect: () => void;
  onDrop?: (ids: string[]) => void;
  menu?: React.ReactNode;
  title?: string;
  highlighted?: boolean;
  color?: string;
}) {
  const [over, setOver] = useState(false);
  const row = (
    <Button
      variant="ghost"
      className={`nav-item paper-nav-item ${active ? "active" : ""}`}
      data-drop-over={over || undefined}
      data-highlighted={highlighted || undefined}
      title={title || label}
      onClick={onSelect}
      onDragOver={
        onDrop
          ? (e) => {
              if (!e.dataTransfer.types.includes(PAPER_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(true);
            }
          : undefined
      }
      onDragLeave={() => setOver(false)}
      onDrop={
        onDrop
          ? (e) => {
              const ids = droppedIds(e);
              setOver(false);
              if (!ids.length) return;
              e.preventDefault();
              e.stopPropagation();
              onDrop(ids);
            }
          : undefined
      }
    >
      <Icon className="size-4" style={color ? { color } : undefined} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {pinned && <Pin className="size-3 text-muted-foreground" />}
      {count !== undefined && <span className="nav-count">{count}</span>}
    </Button>
  );
  if (!menu) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-48">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

function SectionToggle({
  label,
  open,
  onClick,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="bg-transparent hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent"
      aria-label={`${open ? "收起" : "展开"}${label}`}
      aria-expanded={open}
      title={`${open ? "收起" : "展开"}${label}`}
      onClick={onClick}
    >
      {open ? (
        <ChevronDown aria-hidden="true" />
      ) : (
        <ChevronUp aria-hidden="true" />
      )}
    </Button>
  );
}

export function PaperSidebar({
  documents,
  jobs,
  trashCount,
  openDocument,
  onNewCategory,
}: {
  documents: Document[];
  jobs: Map<string, Processing>;
  trashCount: number;
  openDocument: (doc: Document) => void;
  onNewCategory: () => void;
}) {
  const prefs = useReaderStore((s) => s.libraryPreferences.papers) || {};
  const { view, setView, select, selectedId, setNaming, setSmartEditing } =
    usePaperUI();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const collapsedSections = prefs.collapsedSections || [];
  const isOpen = (name: string) => !collapsedSections.includes(name);
  const toggleSection = (name: string) =>
    void savePaperPreferences((p) => {
      const items = p.collapsedSections || [];
      return {
        ...p,
        collapsedSections: items.includes(name)
          ? items.filter((item) => item !== name)
          : [...items, name],
      };
    });
  const sectionToggle = (name: string) => (
    <SectionToggle
      label={name}
      open={isOpen(name)}
      onClick={() => toggleSection(name)}
    />
  );
  const alt = useAltKey();
  const pinned = prefs.pinned || [];
  const hidden = prefs.hidden || [];
  const subcategoryItems = prefs.subcategoryItems !== false;
  const categories = paperCategories(prefs, documents);
  const duplicates = duplicateGroups(documents, prefs.notDuplicates).flat()
    .length;
  const smart = prefs.smartCategories || [];
  const context = { subcategories: subcategoryItems, smart };
  const count = (v: PaperView, subcategories = subcategoryItems) =>
    v === "duplicates"
      ? duplicates
      : documents.filter((d) =>
          matchesView(d, v, jobs, { subcategories, smart }),
        ).length;
  const byId = new Map(documents.map((d) => [d.id, d]));
  // Holding ⌥ marks every category that holds the selected paper.
  const marked = alt && selectedId ? byId.get(selectedId) : undefined;
  const docsFor = (ids: string[]) =>
    ids.map((id) => byId.get(id)).filter((d): d is Document => !!d);
  const choose = (next: PaperView) => {
    setView(next);
    select(null);
  };
  const pinItem = (key: string) => (
    <ContextMenuItem
      onClick={() => void savePaperPreferences((p) => togglePinned(p, key))}
    >
      <Pin />
      {pinned.includes(key) ? "取消置顶" : "置顶"}
    </ContextMenuItem>
  );
  const hideItem = (key: string) => (
    <ContextMenuItem
      onClick={() => {
        void savePaperPreferences((p) => setHidden(p, key, true));
        if (view === key.replace(/^view:/, "")) choose("all");
      }}
    >
      <Eye />
      隐藏
    </ContextMenuItem>
  );
  const viewRow = (v: BuiltinView, isPinned = false) => (
    <SidebarRow
      key={`view:${v}`}
      icon={viewIcons[v]}
      label={viewLabels[v]}
      count={count(v)}
      active={view === v}
      pinned={isPinned}
      onSelect={() => choose(v)}
      onDrop={
        v === "starred"
          ? (ids) => void setStarred(docsFor(ids), true)
          : v === "reading" || v === "unread" || v === "done"
            ? (ids) => void setReadingStatus(docsFor(ids), v as ReadingStatus)
            : undefined
      }
      menu={
        managedViews.includes(v) ? (
          <>
            {pinItem(`view:${v}`)}
            {!isPinned && hideItem(`view:${v}`)}
          </>
        ) : undefined
      }
    />
  );
  const collapsed = new Set(
    (prefs.collapsed || []).map((name) => name.toLowerCase()),
  );
  const toggleCollapsed = (name: string) =>
    void savePaperPreferences((p) => {
      const items = p.collapsed || [];
      return {
        ...p,
        collapsed: items.includes(name)
          ? items.filter((item) => item !== name)
          : [...items, name],
      };
    });
  const open = (name: string) => !collapsed.has(name.toLowerCase());
  const isHidden = (name: string) =>
    hidden.some(
      (key) => key.startsWith("folder:") && withinCategory(name, key.slice(7)),
    );
  const tree = categoryTree(categories.filter((name) => !isHidden(name)));
  const nested = tree.some((node) => node.children.length > 0);
  const categoryRow = (
    node: Pick<CategoryNode, "name" | "label" | "depth" | "children">,
    isPinned = false,
  ) => {
    const { name } = node;
    const key = `folder:${name}` as const;
    const parent = categoryParent(name);
    const expanded = open(name);
    const indent = {
      "--depth": isPinned ? 0 : node.depth,
      "--gutter": nested && !isPinned ? "14px" : "0px",
    } as React.CSSProperties;
    if (renaming === name && !isPinned)
      return (
        <form
          key={key}
          className="paper-nav-edit"
          style={indent}
          onSubmit={(e) => {
            e.preventDefault();
            const leaf = String(new FormData(e.currentTarget).get("name"));
            if (leaf.includes("/")) {
              toast.error("分类名不能包含“/”");
              return;
            }
            void renameCategory(name, parent ? `${parent}/${leaf}` : leaf).then(
              (ok) => {
                if (ok) setRenaming(null);
              },
            );
          }}
        >
          <Folder className="size-4" />
          <Input
            name="name"
            autoFocus
            maxLength={40}
            aria-label="分类名"
            defaultValue={node.label}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={(e) => {
              if (e.currentTarget.value.trim() === node.label)
                setRenaming(null);
            }}
          />
        </form>
      );
    const position = siblingPosition(categories, name);
    const hasChildren = node.children.length > 0;
    const colored = prefs.colorCategories || [];
    const colorIndex = colored.findIndex((item) => item.name === name);
    const row = (
      <SidebarRow
        key={key}
        icon={hasChildren && expanded && !isPinned ? FolderOpen : Folder}
        label={isPinned ? categoryLeaf(name) : node.label}
        title={name.replaceAll("/", " / ")}
        count={count(key)}
        active={view === key}
        pinned={isPinned}
        highlighted={marked?.folders.some((folder) =>
          withinCategory(folder, name),
        )}
        color={colored[colorIndex]?.color}
        onSelect={() => choose(key)}
        onDrop={(ids) => void addToCategory(docsFor(ids), name)}
        menu={
          <>
            {pinItem(key)}
            <ContextMenuItem onClick={() => setNaming([], name)}>
              <FolderPlus />
              新建子分类…
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setRenaming(name)}>
              改名
            </ContextMenuItem>
            <ContextMenuItem
              disabled={position.index <= 0}
              onClick={() =>
                void savePaperPreferences((p) => ({
                  ...p,
                  categories: moveCategory(categories, name, -1),
                }))
              }
            >
              上移
            </ContextMenuItem>
            <ContextMenuItem
              disabled={
                position.index < 0 || position.index >= position.count - 1
              }
              onClick={() =>
                void savePaperPreferences((p) => ({
                  ...p,
                  categories: moveCategory(categories, name, 1),
                }))
              }
            >
              下移
            </ContextMenuItem>
            {!isPinned && hideItem(key)}
            <ContextMenuSub>
              <ContextMenuSubTrigger>颜色</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-40">
                <ContextMenuRadioGroup
                  value={colored[colorIndex]?.color || ""}
                  onValueChange={(value: string) => {
                    const next = setCategoryColor(prefs, name, value || null);
                    if (next) void savePaperPreferences(() => next);
                    else
                      toast.error(
                        `最多 ${MAX_COLOR_CATEGORIES} 个彩色分类，对应数字键 1–9`,
                      );
                  }}
                >
                  {categoryColors.map((c) => (
                    <ContextMenuRadioItem key={c.value} value={c.value}>
                      <span
                        className="color-dot"
                        style={{ background: c.value }}
                      />
                      {c.label}
                    </ContextMenuRadioItem>
                  ))}
                  <ContextMenuRadioItem value="">无颜色</ContextMenuRadioItem>
                </ContextMenuRadioGroup>
                {colorIndex >= 0 && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem disabled>
                      快捷键
                      <ContextMenuShortcut>
                        {colorIndex + 1}
                      </ContextMenuShortcut>
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
            {hasChildren && (
              <ContextMenuCheckboxItem
                checked={subcategoryItems}
                onCheckedChange={(checked) =>
                  void savePaperPreferences((p) => ({
                    ...p,
                    subcategoryItems: checked,
                  }))
                }
              >
                显示子分类中的论文
              </ContextMenuCheckboxItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() =>
                exportCitations(
                  documents.filter((d) => matchesView(d, key, jobs, context)),
                  categoryLeaf(name),
                )
              }
            >
              <FileDown />
              导出引用
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => setDeleting(name)}
            >
              <Trash2 />
              删除
            </ContextMenuItem>
          </>
        }
      />
    );
    if (isPinned) return row;
    return (
      <div key={key} className="paper-nav-node" style={indent}>
        {hasChildren && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="paper-nav-twisty"
            aria-label={`${expanded ? "折叠" : "展开"}“${node.label}”`}
            aria-expanded={expanded}
            onClick={() => toggleCollapsed(name)}
          >
            <ChevronRight data-open={expanded || undefined} />
          </Button>
        )}
        {row}
      </div>
    );
  };
  const paperRow = (doc: Document, isPinned = false) => (
    <SidebarRow
      key={`doc:${doc.id}`}
      icon={FileText}
      label={shortTitle(doc)}
      title={doc.title}
      pinned={isPinned}
      onSelect={() => openDocument(doc)}
      menu={
        <>
          <ContextMenuItem onClick={() => openDocument(doc)}>
            <BookOpen />
            打开阅读
          </ContextMenuItem>
          {pinItem(`doc:${doc.id}`)}
          <ContextMenuItem
            onClick={() => {
              choose("all");
              select(doc.id);
            }}
          >
            查看详情
          </ContextMenuItem>
        </>
      }
    />
  );
  const newSmart = () =>
    setSmartEditing({ id: crypto.randomUUID(), name: "", tags: [] });
  const smartRow = (item: SmartCategory, isPinned = false) => {
    const key = `smart:${item.id}` as const;
    return (
      <SidebarRow
        key={key}
        icon={Tags}
        label={item.name}
        title={`${item.name}：含 ${item.tags.map((t) => `#${t}`).join(" ")}`}
        count={count(key)}
        active={view === key}
        pinned={isPinned}
        onSelect={() => choose(key)}
        menu={
          <>
            {pinItem(key)}
            <ContextMenuItem onClick={() => setSmartEditing(item)}>
              <Pencil />
              编辑
            </ContextMenuItem>
            {!isPinned && hideItem(key)}
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() =>
                exportCitations(
                  documents.filter((d) => matchesView(d, key, jobs, context)),
                  item.name,
                )
              }
            >
              <FileDown />
              导出引用
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => {
                void savePaperPreferences((p) =>
                  removeSmartCategory(p, item.id),
                );
                if (view === key) choose("all");
              }}
            >
              <Trash2 />
              删除
            </ContextMenuItem>
          </>
        }
      />
    );
  };
  const deleteSummary = (name: string) => {
    const subs = categories.filter(
      (item) => item !== name && withinCategory(item, name),
    ).length;
    const papers = count(`folder:${name}`, true);
    return [
      subs && `其中的 ${subs} 个子分类也会删除。`,
      papers
        ? `${papers} 篇论文不会被删除，只是不再属于这些分类。`
        : "分类中没有论文。",
    ]
      .filter(Boolean)
      .join("");
  };
  const pinnedRows = pinned
    .map((key) => {
      if (key.startsWith("doc:")) {
        const doc = byId.get(key.slice(4));
        return doc ? paperRow(doc, true) : null;
      }
      if (key.startsWith("smart:")) {
        const item = smart.find((s) => s.id === key.slice(6));
        return item ? smartRow(item, true) : null;
      }
      if (key.startsWith("folder:")) {
        const name = key.slice(7);
        return categories.includes(name)
          ? categoryRow(
              { name, label: categoryLeaf(name), depth: 0, children: [] },
              true,
            )
          : null;
      }
      const v = key.slice(5) as BuiltinView;
      return managedViews.includes(v) ? viewRow(v, true) : null;
    })
    .filter(Boolean);
  const recent = recentPapers(documents, pinned, 10);
  const hiddenLabel = (key: string) =>
    key.startsWith("folder:")
      ? categories.includes(key.slice(7))
        ? key.slice(7).replaceAll("/", " / ")
        : ""
      : key.startsWith("smart:")
        ? smart.find((s) => s.id === key.slice(6))?.name || ""
        : managedViews.includes(key.slice(5) as BuiltinView)
          ? viewLabels[key.slice(5) as BuiltinView]
          : "";
  const hiddenItems = hidden.filter((key) => hiddenLabel(key));
  return (
    <div className="paper-sidebar">
      <nav className="space-y-1" aria-label="论文库">
        {viewRow("all")}
      </nav>
      {pinnedRows.length > 0 && (
        <section>
          <h3 className="paper-nav-heading">置顶{sectionToggle("置顶")}</h3>
          {isOpen("置顶") && <nav className="space-y-0.5">{pinnedRows}</nav>}
        </section>
      )}
      <section>
        <h3 className="paper-nav-heading">阅读{sectionToggle("阅读")}</h3>
        {isOpen("阅读") && (
          <nav className="space-y-0.5">
            {managedViews
              .filter(
                (v) =>
                  !hidden.includes(`view:${v}`) &&
                  !pinned.includes(`view:${v}`),
              )
              .map((v) => viewRow(v))}
            {count("processing") > 0 && viewRow("processing")}
            {count("questions") > 0 && viewRow("questions")}
            {(duplicates > 0 || view === "duplicates") && viewRow("duplicates")}
          </nav>
        )}
      </section>
      <section>
        <h3 className="paper-nav-heading">
          <span className="flex items-center">
            分类
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="新建分类"
                  />
                }
              >
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={onNewCategory}>
                  <Folder />
                  新建分类
                </DropdownMenuItem>
                <DropdownMenuItem onClick={newSmart}>
                  <Tags />
                  新建智能标签分类
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
          {sectionToggle("分类")}
        </h3>
        {isOpen("分类") && (
          <>
            <nav className="space-y-0.5">
              {flattenCategories(
                tree,
                (node) => !open(node.name) && node.children.length > 0,
              ).map((node) => categoryRow(node))}
              {smart
                .filter((item) => !hidden.includes(`smart:${item.id}`))
                .map((item) => smartRow(item))}
              {categories.length > 0 &&
                count("unfiled") > 0 &&
                viewRow("unfiled")}
            </nav>
            {hiddenItems.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      className="mt-1 text-muted-foreground"
                    />
                  }
                >
                  已隐藏 {hiddenItems.length} 项
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {hiddenItems.map((key) => (
                    <DropdownMenuItem
                      key={key}
                      onClick={() =>
                        void savePaperPreferences((p) =>
                          setHidden(p, key, false),
                        )
                      }
                    >
                      <Eye />
                      显示“{hiddenLabel(key)}”
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </section>
      {recent.length > 0 && (
        <section>
          <h3 className="paper-nav-heading">
            最近阅读{sectionToggle("最近阅读")}
          </h3>
          {isOpen("最近阅读") && (
            <nav className="space-y-0.5">
              {recent.map((doc) => paperRow(doc))}
            </nav>
          )}
        </section>
      )}
      {(trashCount > 0 || view === "trash") && (
        <nav>
          <SidebarRow
            icon={Trash2}
            label="回收站"
            count={trashCount}
            active={view === "trash"}
            onSelect={() => choose("trash")}
          />
        </nav>
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除分类“{deleting && categoryLeaf(deleting)}”？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleteSummary(deleting)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void deleteCategory(deleting);
                setDeleting(null);
              }}
            >
              删除分类
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
