import { useShortcut, loadBindings } from "./shortcuts/shortcuts";
import { useSaveReaderSettings } from "./neoread-settings";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Library,
  Star,
  Search,
  Settings2,
  ArrowUpRight,
  FileText,
  Loader2,
  PanelLeft,
  Command,
  X,
  Tags,
  Pencil,
  Check,
  CirclePlus,
  Info,
  Trash2,
  BookOpenText,
} from "lucide-react";
import { version } from "../../desktop/package.json";
import { api, RequestError } from "@neoread/api";
import {
  LargePaperConfirmation,
  LargePaperDialog,
  type LargePaper,
} from "./LargePaperDialog";
import type { Document, LibraryMode } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { TooltipProvider } from "@neoread/ui/components/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";
import { Toaster, toast } from "sonner";
import { CiteHost } from "./cite/CiteHost";
import {
  useReaderStore,
  refreshLibrary,
  libraryMode,
  primaryLibraryMode,
  loadLibraryPreferences,
  updateLibraryPreferences,
  refreshTrash,
  openLinkTarget,
  openLibraryDocument,
} from "./store";
import { TrashView } from "./TrashView";
import { PaperLibrary } from "./papers/PaperLibrary";
import { PaperSidebar } from "./papers/PaperSidebar";
import { usePaperUI } from "./papers/state";
import { ImportPaperDialog } from "./papers/ImportPaperDialog";
import { LibraryModeSwitcher, libraryModes } from "./LibraryModeSwitcher";
import { Settings } from "./Settings";
import { Workspace } from "./Workspace";
import { useProcessing } from "./ProcessingStatus";
import { useUpdateProgress } from "./update-progress";
import { useResolvedTheme } from "./appearance";
import { DocumentEditor, LibraryFilterBar } from "./DocumentManagement";
import { TagBoards } from "./TagBoards";
import { LibraryDocuments } from "./LibraryDocuments";
import { filterDocuments, initialFilters } from "./library";
import { GuideHost } from "./guide/GuideHost";
const currentMode = () =>
  libraryMode(useReaderStore.getState().libraryPreferences);
export function App() {
  const {
    documents: allDocuments,
    active,
    theme,
    setTheme,
    open,
    libraryPreferences,
    trash,
  } = useReaderStore();
  const mode = libraryMode(libraryPreferences);
  const papers = mode === "papers";
  const documents = allDocuments.filter((d) => d.library === mode);
  const resolvedTheme = useResolvedTheme(theme);
  const { jobs, error: processingError } = useProcessing();
  useUpdateProgress();
  const jobsById = useMemo(
    () => new Map(jobs.map((job) => [job.documentId, job])),
    [jobs],
  );
  const [settings, setSettings] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [about, setAbout] = useState(false);
  const [guide, setGuide] = useState(false);
  const [filter, setFilter] = useState("all");
  const [filters, setFilters] = useState(initialFilters);
  const [libraryView, setLibraryView] = useState<"grid" | "list">("grid");
  const [editingLibrary, setEditingLibrary] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [commandQuery, setCommandQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [largePapers, setLargePapers] = useState<LargePaper[]>([]);
  const [largePaperFolder, setLargePaperFolder] = useState("");
  const [loading, setLoading] = useState(true);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [error, setError] = useState("");
  const [command, setCommand] = useState(false);
  const [importingPaper, setImportingPaper] = useState(false);
  const [nav, setNav] = useState(true);
  useShortcut("libraryLeft", () => setNav((value) => !value), !active);
  useShortcut("search", () => setCommand(true), !active);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileFolderRef = useRef("");
  useEffect(() => {
    Promise.all([
      refreshLibrary(),
      loadLibraryPreferences(),
      loadBindings().catch(() =>
        toast.error("快捷键设置读取失败，暂时使用默认快捷键。"),
      ),
      api.settings().then((value) => {
        setTheme(value);
        setSettingsHydrated(true);
      }),
    ])
      .catch((e) => setError(e.message))
      .finally(() => {
        setLoading(false);
      });
  }, [setTheme]);
  useEffect(() => {
    if (loading) return;
    void refreshTrash().catch((e) => toast.error(e.message));
  }, [mode, loading]);
  useSaveReaderSettings(theme, settingsHydrated);
  useEffect(() => {
    const dark = resolvedTheme.mode === "dark";
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.dataset.theme = resolvedTheme.mode;
    // Graphite ("soft") and pure black ("high") are both dark mode.
    if (dark)
      root.dataset.darkContrast = resolvedTheme.pdfDarkContrast ?? "soft";
    else delete root.dataset.darkContrast;
    root.style.colorScheme = dark ? "dark" : "light";
    void window.neoreadDesktop
      ?.setAppearance(theme.appearance ?? "system", {
        pdfDarkContrast: theme.pdfDarkContrast,
        systemLightMode: theme.systemLightMode,
        systemDarkContrast: theme.systemDarkContrast,
      })
      .catch((e) => toast.error(e.message));
  }, [
    resolvedTheme.mode,
    resolvedTheme.pdfDarkContrast,
    theme.appearance,
    theme.pdfDarkContrast,
    theme.systemLightMode,
    theme.systemDarkContrast,
  ]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommand((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        chooseFiles();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const currentPaperFolder = () => {
    const view = usePaperUI.getState().view;
    return currentMode() === "papers" &&
      (view.startsWith("folder:") || view.startsWith("smart:"))
      ? view
      : "";
  };
  const chooseFiles = (folder = currentPaperFolder()) => {
    if (window.neoreadDesktop) {
      setBusy(true);
      void window.neoreadDesktop
        .importFiles(currentMode(), folder)
        .then((large) => {
          setLargePapers(large);
          setLargePaperFolder(folder);
        })
        .catch((e) => toast.error(e.message))
        .finally(() => setBusy(false));
    } else {
      fileFolderRef.current = folder;
      fileRef.current?.click();
    }
  };
  // Long papers are confirmed together: keep them as papers or switch to books.
  const importLargePapers = async (library: LibraryMode) => {
    const papers = largePapers;
    setBusy(true);
    try {
      if (library === "books") switchMode("books");
      const desktop = papers.flatMap((p) => (p.id ? [p.id] : []));
      if (desktop.length)
        await window.neoreadDesktop?.importLargePapers(
          desktop,
          library,
          library === "papers" ? largePaperFolder : "",
        );
      for (const paper of papers)
        if (paper.file)
          await api.import(
            paper.file,
            library,
            true,
            library === "papers" ? largePaperFolder : "",
          );
      await refreshLibrary();
      toast.success(
        `已导入 ${papers.length} 个文件到${libraryModes[library].label}`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLargePapers([]);
      setLargePaperFolder("");
      setBusy(false);
    }
  };
  useEffect(() => {
    if (loading) return;
    return window.neoreadDesktop?.onOpenLink?.((target) => {
      void openLinkTarget(target)
        .then((found) => {
          if (!found) toast.error("找不到这份文档，它可能已被删除或在回收站中");
        })
        .catch((e) => toast.error((e as Error).message));
    });
  }, [loading]);
  useEffect(
    () =>
      window.neoreadDesktop?.onLibraryChanged(() => {
        void refreshLibrary().catch((e) => toast.error(e.message));
      }),
    [],
  );
  useEffect(() => {
    let active = true;
    let revision: number | null = null;
    const check = async () => {
      try {
        const latest = (await api.connectorRevision()).revision;
        if (!active) return;
        if (revision !== null && latest !== revision) await refreshLibrary();
        revision = latest;
      } catch {
        /* NeoRead shutdown is handled by the desktop shell. */
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const importFiles = async (files: File[], folder = currentPaperFolder()) => {
    const target = currentMode();
    const accepted = files.filter((file) =>
      target === "papers"
        ? /\.pdf$/i.test(file.name)
        : /\.(epub|pdf)$/i.test(file.name),
    );
    if (accepted.length < files.length)
      toast.info(
        target === "papers"
          ? "论文库只支持 PDF，已跳过其他文件"
          : "仅支持 EPUB 和 PDF，已跳过其他文件",
      );
    if (!accepted.length) return;
    setBusy(true);
    try {
      const elsewhere: Document[] = [];
      const large: LargePaper[] = [];
      for (const file of accepted) {
        try {
          const document = await api.import(
            file,
            target,
            false,
            target === "papers" ? folder : "",
          );
          if (document.library !== target) elsewhere.push(document);
        } catch (e) {
          if (!(e instanceof RequestError) || e.code !== "large-paper") throw e;
          large.push({ name: file.name, pages: e.pages ?? 0, file });
        }
      }
      await refreshLibrary();
      setLargePapers(large);
      setLargePaperFolder(folder);
      if (elsewhere.length)
        toast.info(
          `${elsewhere.length} 个文件已在${libraryModes[elsewhere[0].library].label}中，可在那里移动`,
        );
      const imported = accepted.length - elsewhere.length - large.length;
      if (imported > 0) toast.success(`已导入 ${imported} 个文件`);
      setError("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sample = async () => {
    setBusy(true);
    try {
      for (const name of ["the-art-of-reading.epub", "reading-notes.pdf"]) {
        const response = await fetch(`/samples/${name}`);
        if (!response.ok) throw new Error("示例文件不可用");
        await api.import(new File([await response.blob()], name));
      }
      await refreshLibrary();
      toast.success("已添加两份示例，可随时开始阅读");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const switchMode = (next: LibraryMode) => {
    if (next === mode) return;
    setFilter("all");
    setFilters(initialFilters);
    setQuery("");
    setEditingLibrary(false);
    void updateLibraryPreferences({ mode: next }).catch((e) =>
      toast.error(e.message),
    );
  };
  const openLibrary = (next: LibraryMode) => {
    open(null);
    switchMode(next);
  };
  const primaryMode = primaryLibraryMode(libraryPreferences);
  useShortcut("primaryLibrary", () => openLibrary(primaryMode), !loading);
  useShortcut(
    "secondaryLibrary",
    () => openLibrary(primaryMode === "papers" ? "books" : "papers"),
    !loading,
  );
  const moveDocument = async (doc: Document, library: LibraryMode) => {
    try {
      await api.update(doc.id, { library });
      await refreshLibrary();
      toast.success(`已移到${libraryModes[library].label}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const openDocument = (doc: Document) => {
    void openLibraryDocument(doc)
      .then(async (opened) => {
        if (!opened) return;
        setEditingLibrary(false);
        await api.update(doc.id, {});
      })
      .catch((e) => toast.error(e.message));
  };
  const filtered = filterDocuments(
    documents,
    filter,
    filter === "all" ? "" : query,
    filters,
  );
  const searchResults = filterDocuments(
    documents,
    "all",
    commandQuery,
    initialFilters,
  );
  const editing = documents.find((d) => d.id === editingId);
  const awaitingClassification = documents.some(
    (d) =>
      d.classificationStatus === "pending" ||
      d.classificationStatus === "running",
  );
  useEffect(() => {
    if (!awaitingClassification) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshLibrary();
      } catch {
        /* Keep the last available library during a transient disconnect. */
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [awaitingClassification]);
  const favorite = async (doc: Document) => {
    try {
      await api.update(doc.id, { favorite: !doc.favorite });
      await refreshLibrary();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <TooltipProvider>
      <div
        className="app"
        data-platform={window.neoreadDesktop?.platform}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          void importFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          type="file"
          ref={fileRef}
          hidden
          multiple
          accept={papers ? ".pdf" : ".pdf,.epub"}
          onChange={(e) => {
            void importFiles(
              Array.from(e.target.files || []),
              fileFolderRef.current,
            );
            e.target.value = "";
          }}
        />
        {active ? (
          <Workspace
            key={active.id}
            document={active}
            theme={resolvedTheme}
            processing={jobs.find((job) => job.documentId === active.id)}
            onBack={() => {
              open(null);
              void refreshLibrary();
            }}
            onSettings={() => setSettings(true)}
          />
        ) : (
          <>
            {/* Outside the sidebar, which is transformed while collapsed. */}
            <div className="window-top-drag" aria-hidden="true" />
            <aside
              className={`library-sidebar ${nav ? "" : "collapsed"}`}
              inert={!nav}
            >
              <div className="window-drag-handle" aria-hidden="true" />
              <LibraryModeSwitcher mode={mode} onChange={switchMode} />
              <Button
                className="w-full justify-between"
                variant="outline"
                onClick={() => setCommand(true)}
              >
                <span className="flex items-center gap-2">
                  <Search className="size-3.5" />
                  快速查找
                </span>
                <kbd>⌘ K</kbd>
              </Button>
              {papers ? (
                <PaperSidebar
                  documents={documents}
                  jobs={jobsById}
                  trashCount={trash.length}
                  openDocument={openDocument}
                  onNewCategory={() => usePaperUI.getState().setNaming([])}
                />
              ) : (
                <nav className="space-y-1">
                  {[
                    {
                      id: "all",
                      label: papers ? "全部论文" : "全部文档",
                      icon: Library,
                      count: documents.length,
                    },
                    {
                      id: "tags",
                      label: "标签看板",
                      icon: Tags,
                      count: undefined,
                    },
                    {
                      id: "favorites",
                      label: "收藏",
                      icon: Star,
                      count: documents.filter((d) => d.favorite).length,
                    },
                    ...(trash.length || filter === "trash"
                      ? [
                          {
                            id: "trash",
                            label: "回收站",
                            icon: Trash2,
                            count: trash.length,
                          },
                        ]
                      : []),
                  ].map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className={`nav-item ${filter === item.id ? "active" : ""}`}
                      onClick={() => {
                        setFilter(item.id);
                        setEditingLibrary(false);
                      }}
                    >
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                      <span className="nav-count">{item.count}</span>
                    </Button>
                  ))}
                </nav>
              )}
              <div className="sidebar-bottom">
                <Button
                  data-tour="import"
                  className="mb-2 h-10 w-full gap-2 rounded-full"
                  onClick={
                    papers ? () => setImportingPaper(true) : () => chooseFiles()
                  }
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CirclePlus className="size-4" />
                  )}
                  <span>
                    {busy ? "导入中…" : papers ? "导入论文" : "导入文档"}
                  </span>
                </Button>
                <Button
                  data-tour="open-settings"
                  variant="ghost"
                  className="nav-item"
                  onClick={() => setSettings(true)}
                >
                  <Settings2 />
                  设置
                </Button>
                <Button
                  data-tour="guide"
                  variant="ghost"
                  className="nav-item"
                  onClick={() => setGuide(true)}
                >
                  <BookOpenText className="size-4" />
                  指南
                </Button>
                <Button
                  variant="ghost"
                  className="nav-item"
                  onClick={() => setAbout(true)}
                >
                  <Info className="size-4" />
                  <span>
                    关于{" "}
                    <span className="text-muted-foreground/70">
                      ({version})
                    </span>
                  </span>
                </Button>
              </div>
            </aside>
            {papers ? (
              <PaperLibrary
                documents={documents}
                trash={trash}
                jobs={jobsById}
                loading={loading}
                openDocument={openDocument}
                moveToBooks={(doc) => void moveDocument(doc, "books")}
                navOpen={nav}
                onToggleNav={() => setNav(!nav)}
              />
            ) : (
              <main className="library-main">
                <header className="library-topbar">
                  <div className="flex items-center gap-3">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="切换侧栏"
                      aria-expanded={nav}
                      onClick={() => setNav(!nav)}
                    >
                      <PanelLeft />
                    </Button>
                    <h1 className="library-title">
                      {filter === "tags"
                        ? "标签看板"
                        : filter === "trash"
                          ? "回收站"
                          : filter === "favorites"
                            ? "收藏"
                            : papers
                              ? "全部论文"
                              : "全部文档"}
                    </h1>
                  </div>
                  {filter === "tags" ? (
                    <div className="search-field">
                      <Search className="size-4" />
                      <Input
                        aria-label="搜索书库"
                        placeholder="搜索标题、作者、标签…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                  ) : filter === "trash" ? null : (
                    <Button
                      variant={editingLibrary ? "secondary" : "outline"}
                      aria-pressed={editingLibrary}
                      disabled={!filtered.length && !editingLibrary}
                      onClick={() => setEditingLibrary(!editingLibrary)}
                    >
                      {editingLibrary ? <Check /> : <Pencil />}
                      {editingLibrary ? "完成" : "编辑"}
                    </Button>
                  )}
                </header>
                <div className="library-content">
                  {filter === "favorites" && (
                    <div className="library-controls">
                      <div className="search-field">
                        <Search className="size-4" />
                        <Input
                          aria-label="搜索书库"
                          placeholder="搜索标题、作者、标签…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                  {filter !== "tags" && filter !== "trash" && (
                    <LibraryFilterBar
                      documents={documents}
                      filters={filters}
                      onChange={setFilters}
                      view={libraryView}
                      onViewChange={setLibraryView}
                      count={filtered.length}
                    />
                  )}
                  {processingError && (
                    <p className="processing-warning" role="status">
                      解析进度暂时不可用：{processingError}
                    </p>
                  )}
                  {error ? (
                    <div className="empty-state">
                      <h2>暂时无法连接本地书库</h2>
                      <p>{error}</p>
                      <Button
                        variant="outline"
                        onClick={() => location.reload()}
                      >
                        重新连接
                      </Button>
                    </div>
                  ) : loading ? (
                    <div className="empty-state">
                      <Loader2 className="animate-spin text-muted-foreground" />
                      <p>正在打开本地书库</p>
                    </div>
                  ) : filter === "trash" ? (
                    <TrashView documents={trash} />
                  ) : filter === "tags" ? (
                    <TagBoards
                      documents={documents}
                      query={query}
                      jobs={jobs}
                      processingError={processingError}
                      openDocument={openDocument}
                      favorite={favorite}
                      onEdit={setEditingId}
                      onSettings={() => setSettings(true)}
                    />
                  ) : filtered.length ? (
                    <LibraryDocuments
                      key={JSON.stringify([filter, query, filters])}
                      documents={filtered}
                      libraryView={libraryView}
                      editing={editingLibrary}
                      onEditingChange={setEditingLibrary}
                      jobs={jobs}
                      processingError={processingError}
                      openDocument={openDocument}
                      favorite={favorite}
                      onEdit={setEditingId}
                      onMove={moveDocument}
                      onSettings={() => setSettings(true)}
                    />
                  ) : (
                    <div className="empty-state">
                      <div className="empty-books">
                        <span>
                          <FileText />
                        </span>
                        <span>
                          <BookOpen />
                        </span>
                      </div>
                      <h2>
                        {documents.length
                          ? "没有符合筛选条件的文档"
                          : filter === "favorites"
                            ? "暂无收藏"
                            : papers
                              ? "暂无论文"
                              : "暂无文档"}
                      </h2>
                      {!!documents.length && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setFilters(initialFilters);
                            setQuery("");
                            setFilter("all");
                          }}
                        >
                          显示全部文档
                        </Button>
                      )}
                      {!documents.length && !papers && (
                        <Button
                          variant="link"
                          onClick={() => void sample()}
                          disabled={busy}
                        >
                          先体验示例文档 <ArrowUpRight className="size-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </main>
            )}
          </>
        )}
        {editing && (
          <DocumentEditor
            key={editing.id}
            document={editing}
            documents={documents}
            onClose={() => setEditingId(null)}
          />
        )}
        <Settings open={settings} onOpenChange={setSettings} />
        <ImportPaperDialog
          open={importingPaper}
          onOpenChange={setImportingPaper}
          onChooseFiles={(folder) => chooseFiles(folder)}
        />
        <GuideHost
          ready={!loading && !error}
          version={version}
          hasDocuments={allDocuments.length > 0}
          open={guide}
          onOpenChange={setGuide}
          onAction={(action) => {
            if (action === "settings") setSettings(true);
            else if (currentMode() === "papers") setImportingPaper(true);
            else chooseFiles();
          }}
        />
        <Dialog open={about} onOpenChange={setAbout}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>关于 NeoRead</DialogTitle>
              <DialogDescription>一千万以内最好的阅读器</DialogDescription>
            </DialogHeader>
            <dl className="flex items-center justify-between text-sm">
              <dt className="text-muted-foreground">版本</dt>
              <dd>{version}</dd>
            </dl>
            {window.neoreadDesktop?.checkForUpdates && (
              <Button
                variant="outline"
                disabled={checkingUpdates}
                onClick={() => {
                  setCheckingUpdates(true);
                  void window
                    .neoreadDesktop!.checkForUpdates()
                    .catch((error) => toast.error(String(error)))
                    .finally(() => setCheckingUpdates(false));
                }}
              >
                {checkingUpdates ? "正在检查或下载…" : "检查更新"}
              </Button>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={command} onOpenChange={setCommand}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Command size={18} />
                快速查找
              </DialogTitle>
              <DialogDescription>搜索书库，或打开常用操作。</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              placeholder="搜索标题、作者、标签…"
              value={commandQuery}
              onChange={(e) => setCommandQuery(e.target.value)}
            />
            <div className="min-w-0 max-h-72 space-y-1 overflow-auto">
              {searchResults.map((d) => (
                <Button
                  key={d.id}
                  variant="ghost"
                  className="min-w-0 w-full justify-start"
                  title={d.title}
                  onClick={() => {
                    openDocument(d);
                    setCommand(false);
                  }}
                >
                  <BookOpen />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {d.title}
                  </span>
                </Button>
              ))}
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => {
                  setCommand(false);
                  setSettings(true);
                }}
              >
                <Settings2 />
                打开设置
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <LargePaperConfirmation />
        <LargePaperDialog
          papers={largePapers}
          busy={busy}
          onChoose={(library) => void importLargePapers(library)}
          onCancel={() => setLargePapers([])}
        />
        <CiteHost />
        <Toaster
          richColors
          position="bottom-right"
          theme={resolvedTheme.mode === "dark" ? "dark" : "light"}
        />
      </div>
    </TooltipProvider>
  );
}
