import { webSearchEnabled } from "./chat/web-search";
import { NavigationTree } from "./NavigationTree";
import { useShortcut } from "./shortcuts/shortcuts";
import { useDocumentTheme } from "./useDocumentTheme";
import {
  readerLayout,
  sidebarLayout,
  updateReaderLayout,
} from "./neoread-layout";
import { SelectionTranslation } from "./SelectionTranslation";
import { LinkPreviewPanel } from "./LinkPreviewPanel";
import { AnnotationHoverCard } from "./AnnotationHoverCard";
import { AnnotationQuote } from "./AnnotationQuote";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  Languages,
  ChartColumn,
  ArrowLeft,
  BookOpen,
  PanelLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ListTree,
  Search,
  BookmarkPlus,
  Sparkles,
  Settings2,
  Underline,
  MessageSquare,
  X,
  StickyNote,
  Send,
  Square,
  Quote,
  Type,
  Sun,
  Moon,
  Check,
  CircleHelp,
} from "lucide-react";
import { api, blockImageURL } from "@neoread/api";
import {
  locationLabel,
  type DocumentChatSession,
  type Annotation,
  type Document as ReaderDocument,
  type DocumentLocation,
  type ReaderAdapter,
  type ReaderSelection,
  type ReaderAnnotationTarget,
  type TOCItem,
  type SearchResult,
  type ReaderTheme,
  type Processing,
  type PDFBlock,
  type PDFBlockAction,
  type EPUBReadingBlock,
  type ImageAttachment,
  type LinkPreview,
  neoreadLink,
} from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Badge } from "@neoread/ui/components/badge";
import { Input } from "@neoread/ui/components/input";
import { Textarea } from "@neoread/ui/components/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@neoread/ui/components/tabs";
import { ScrollArea } from "@neoread/ui/components/scroll-area";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@neoread/ui/components/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";
import {
  ResizablePanelGroup,
  ResizablePanel,
  usePanelRef,
  ResizableHandle,
} from "@neoread/ui/components/resizable";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@neoread/ui/components/tooltip";
import { toast } from "sonner";
import { DocumentOverviewDialog } from "./DocumentOverview";
import { ProcessingUsageDialog } from "./ProcessingUsage";
import { ModelSelector } from "./ModelSelector";
import { SourceReferences } from "./SourceReferences";
import { ChatSession } from "./chat/chat-session";
import { getChatSession } from "./chat/session-registry";
import { SessionPicker } from "./chat/SessionPicker";
import { AssistantPanel } from "./chat/AssistantPanel";
import { CodexHandoffButton } from "./chat/CodexHandoffButton";
import { ImagePreview, imageLabel } from "./ImagePreview";
import { readingContext } from "./chat/reading-context";
import { referenceLabel } from "./references";
import { ReferenceNavigation } from "./reference-navigation";
import { SelectionToolbar } from "./SelectionToolbar";
import { AnnotationToolbar, annotationLabels } from "./AnnotationToolbar";
import { useAnnotationUndo } from "./useAnnotationUndo";
import { useAnnotationDeletion } from "./useAnnotationDeletion";
import {
  activeAnnotation,
  applySavedAnnotation,
  highlightPalette,
} from "./annotations";
import { ColorSwatches } from "./ColorSwatches";
import { useSelectionClipboard } from "./useSelectionClipboard";
import { copyImage, copyText } from "./chat/clipboard";
import { NotesPanel } from "./NotesPanel";
import { ExportDocumentDialog } from "./ExportDocumentDialog";
import { EPUBReadingView } from "./translation/EPUBReadingView";
import { PDFReadingView } from "./translation/PDFReadingView";
import { useReaderStore } from "./store";
import { scheduleProgress, flushProgress } from "./progress";
import { Slider } from "@neoread/ui/components/slider";
import { TranslationFontControls } from "./TranslationFontControls";
import { AppearancePicker } from "./AppearancePicker";
function IconButton({
  label,
  children,
  onClick,
  active = false,
  expanded,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  expanded?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-expanded={expanded}
            size="icon-sm"
            variant={active ? "secondary" : "ghost"}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
export function Workspace({
  document: doc,
  active = true,
  theme: sharedTheme,
  processing,
  onBack,
  onSettings,
}: {
  document: ReaderDocument;
  active?: boolean;
  theme: ReaderTheme;
  processing?: Processing;
  onBack: () => void;
  onSettings: () => void;
}) {
  const { aiConfig, setAIConfig, aiModelSaving } = useReaderStore();
  const { theme, setTheme, onZoom } = useDocumentTheme(
    sharedTheme,
    doc,
    active,
  );
  const translationSize = theme.translationFontSize ?? 1;
  const assistantSize = theme.assistantFontScale ?? 1;
  const linkTarget = useReaderStore((s) => s.linkTarget);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [blocks, setBlocks] = useState<PDFBlock[]>([]);
  const [adapter, setAdapter] = useState<ReaderAdapter>();
  const [readingToolbar, setReadingToolbar] = useState<HTMLDivElement | null>(
    null,
  );
  const [sourceAutoCenterToolbar, setSourceAutoCenterToolbar] =
    useState<HTMLDivElement | null>(null);
  const renderBlockImage = useMemo(
    () => adapter?.renderBlockImage?.bind(adapter),
    [adapter],
  );
  const referenceNavigation = useMemo(
    () => (adapter ? new ReferenceNavigation(adapter) : undefined),
    [adapter],
  );
  const [returnLocation, setReturnLocation] = useState<DocumentLocation>();
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null);
  const navigationRef = useRef(referenceNavigation);
  navigationRef.current = referenceNavigation;
  const [referenceBusy, setReferenceBusy] = useState(false);
  const visitReference = async (target: DocumentLocation, text: string) => {
    if (!adapter || !referenceNavigation || referenceNavigation.busy) return;
    setReferenceBusy(true);
    try {
      await referenceNavigation.visit(target, async (location) => {
        if (!(await adapter.focusReference?.(location, text)))
          await adapter.goTo(location);
      });
      setReturnLocation(referenceNavigation.origin);
    } finally {
      setReferenceBusy(false);
    }
  };
  const returnFromReference = async () => {
    if (!referenceNavigation) return;
    setReferenceBusy(true);
    try {
      await referenceNavigation.back();
      setReturnLocation(referenceNavigation.origin);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReferenceBusy(false);
    }
  };
  const [toc, setTOC] = useState<TOCItem[]>([]);
  const [location, setLocation] = useState<DocumentLocation | undefined>(
    doc.progress,
  );
  const [translationSelection, setTranslationSelection] =
    useState<ReaderSelection | null>(null);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const recoveryDocument = useRef(doc.id);
  recoveryDocument.current = doc.id;
  const annotationSaving = useRef(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const selectionClipboard = useSelectionClipboard(theme.autoCopySelection);
  const [annotationTarget, setAnnotationTarget] =
    useState<ReaderAnnotationTarget | null>(null);
  const { deleting, remove: removeAnnotation } = useAnnotationDeletion(
    doc.id,
    (id) => {
      setAnnotations((items) => items.filter((item) => item.id !== id));
      setAnnotationTarget((target) => {
        if (!target) return null;
        const ids = target.ids.filter((item) => item !== id);
        return ids.length ? { ...target, ids } : null;
      });
    },
  );
  const layout = readerLayout(theme.readerLayout);
  const left = layout.navigationOpen;
  const right = layout.assistantOpen;
  const setLeft = (navigationOpen: boolean) => {
    adapter?.cancelBlockFocus?.();
    updateReaderLayout({ navigationOpen });
  };
  const setRight = (assistantOpen: boolean) => {
    adapter?.cancelBlockFocus?.();
    updateReaderLayout({ assistantOpen });
  };
  const initialLayout = useRef(sidebarLayout(layout));
  const leftPanel = usePanelRef();
  const rightPanel = usePanelRef();
  const panelGroup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const group = panelGroup.current;
    const changes = [
      [leftPanel.current, left, layout.navigationWidth],
      [rightPanel.current, right, layout.assistantWidth],
    ] as const;
    if (
      !group ||
      !changes.some(([panel, open]) => panel && panel.isCollapsed() === open)
    )
      return;
    group.setAttribute("data-toggling", "");
    for (const [panel, open, width] of changes) {
      if (panel && panel.isCollapsed() === open) {
        if (open) panel.resize(`${width}%`);
        else panel.collapse();
      }
    }
    const timer = setTimeout(() => group.removeAttribute("data-toggling"), 240);
    return () => {
      clearTimeout(timer);
      group.removeAttribute("data-toggling");
    };
  }, [
    left,
    right,
    layout.navigationWidth,
    layout.assistantWidth,
    leftPanel,
    rightPanel,
  ]);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [rightTab, setRightTab] = useState("ai");
  const [leftTab, setLeftTab] = useState("toc");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteKind, setNoteKind] = useState<"note" | "question">("note");
  const palette = highlightPalette(useReaderStore((s) => s.theme));
  const [savedColor, setMarkColor] = useState<string>(() => {
    try {
      return localStorage.getItem("neoread.mark-color") || "";
    } catch {
      return "";
    }
  });
  // The last color used, while it is still in the palette.
  const markColor = palette.some((c) => c.value === savedColor)
    ? savedColor
    : palette[0].value;
  const chooseColor = (color: string) => {
    setMarkColor(color);
    try {
      localStorage.setItem("neoread.mark-color", color);
    } catch {
      /* the color only lasts for this session */
    }
  };
  const [answering, setAnswering] = useState<Set<string>>(new Set());
  const [exportingNotes, setExportingNotes] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(
    null,
  );
  const [noteSelection, setNoteSelection] = useState<ReaderSelection | null>(
    null,
  );
  const readingPane = useRef<HTMLDivElement>(null);
  const [sessionCatalog, setSessionCatalog] = useState<{
    documentId: string;
    items: DocumentChatSession[];
  }>({ documentId: doc.id, items: [] });
  const [selectedSession, setSelectedSession] = useState<{
    documentId: string;
    id: string;
  }>({ documentId: doc.id, id: "" });
  const [sessionError, setSessionError] = useState("");
  const currentDocument = useRef(doc.id);
  currentDocument.current = doc.id;
  const sessions =
    sessionCatalog.documentId === doc.id ? sessionCatalog.items : [];
  let preferred =
    selectedSession.documentId === doc.id ? selectedSession.id : "";
  if (!preferred) {
    try {
      preferred = localStorage.getItem(`neoread.chat-session.${doc.id}`) || "";
    } catch {}
  }
  const currentSession =
    sessions.find((s) => s.id === preferred) ?? sessions[0];
  const provider = aiConfig?.primary ?? "";
  const webSearch = webSearchEnabled(provider, aiConfig?.webSearch);
  const sessionListSerial = useRef(0);
  const refreshSessions = useCallback(async () => {
    const serial = ++sessionListSerial.current;
    const items = await api.chatSessions(doc.id, AbortSignal.timeout(15_000));
    if (
      currentDocument.current === doc.id &&
      serial === sessionListSerial.current
    ) {
      setSessionCatalog({ documentId: doc.id, items });
      setSessionError("");
    }
  }, [doc.id]);
  const selectSession = (id: string) => {
    setSelectedSession({ documentId: doc.id, id });
    try {
      localStorage.setItem(`neoread.chat-session.${doc.id}`, id);
    } catch {}
  };
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshSessions();
      } catch (error) {
        if (alive) setSessionError((error as Error).message);
      } finally {
        if (alive) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refreshSessions]);
  const [prompt, setPrompt] = useState("");
  const [quotes, setQuotes] = useState<ReaderSelection[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImageAttachment>();
  const composeInput = useRef<HTMLTextAreaElement>(null);
  const composerDrafts = useRef(
    new Map<
      string,
      { prompt: string; quotes: ReaderSelection[]; images: ImageAttachment[] }
    >(),
  );
  const composerValue = useRef({ prompt, quotes, images });
  composerValue.current = { prompt, quotes, images };
  const composerKey = `${doc.id}:${currentSession?.id ?? ""}`;
  useEffect(() => {
    const saved = composerDrafts.current.get(composerKey);
    setPrompt(saved?.prompt ?? "");
    setQuotes(saved?.quotes ?? []);
    setImages(saved?.images ?? []);
    return () => {
      composerDrafts.current.set(composerKey, composerValue.current);
    };
  }, [composerKey]);
  useEffect(() => {
    let alive = true;
    void api
      .aiConfig()
      .then((config) => {
        if (alive) setAIConfig(config);
      })
      .catch((error) => {
        if (alive) toast.error(error.message);
      });
    return () => {
      alive = false;
    };
  }, [setAIConfig]);
  const emptySession = useMemo(() => new ChatSession(doc.id), [doc.id]);
  const session = currentSession
    ? getChatSession(doc.id, currentSession.id)
    : emptySession;
  const chat = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    if (
      !currentSession ||
      currentSession.latestRun?.status !== "running" ||
      chat.busy
    )
      return;
    const timer = setTimeout(() => void session.load(), 3000);
    return () => clearTimeout(timer);
  }, [
    currentSession?.latestRun?.id,
    currentSession?.latestRun?.status,
    chat.busy,
    session,
  ]);
  const sendSerial = useRef(0);
  const [preparing, setSending] = useState(false);
  const sending = preparing || chat.busy;
  const [pageInput, setPageInput] = useState("");
  const abort = useRef<AbortController | null>(null);
  const searchSerial = useRef(0);
  useEffect(() => {
    searchSerial.current++;
    setQuery("");
    setResults([]);
    setSearchedQuery("");
    setSearching(false);
  }, [doc.id]);
  useShortcut("readerLeft", () => setLeft(!left));
  useShortcut("readerRight", () => setRight(!right));
  useShortcut("search", () => {
    setLeft(true);
    setLeftTab("search");
    requestAnimationFrame(() => searchInput.current?.focus());
  });
  useEffect(() => {
    let alive = true;
    session.activate();
    abort.current = null;
    if (currentSession) void session.load();
    setSending(false);
    api
      .recoverAnnotations(doc.id)
      .catch((e) => toast.error(e.message))
      .then(() => api.annotations(doc.id))
      .then((a) => {
        if (alive) {
          setAnnotations(a);
          setAnnotationsLoaded(true);
        }
      })
      .catch((e) => toast.error(e.message));
    return () => {
      alive = false;
      sendSerial.current++;
      abort.current?.abort();
      // A viewer switch must not abort its independently owned run.
      void flushProgress().catch((e) => toast.error(e.message));
    };
  }, [doc.id, session]);
  useEffect(() => {
    if (doc.type !== "pdf" || processing?.phase === "learning") return;
    let alive = true;
    void api
      .blocks(doc.id)
      .then((value) => {
        if (alive) setBlocks(value);
      })
      .catch((e) => toast.error(e.message));
    return () => {
      alive = false;
    };
  }, [
    doc.id,
    doc.type,
    processing?.phase,
    processing?.status,
    processing?.layoutRevision,
    // Book pages parsed in the background add blocks as they arrive.
    processing?.bookLayout?.pagesDone,
  ]);
  const move = (next: DocumentLocation) => {
    void adapter?.goTo(next).catch((e) => toast.error(e.message));
  };
  const focusAnnotation = (annotation: Annotation) => {
    const go = adapter?.focusLocation
      ? adapter.focusLocation(annotation.location)
      : adapter?.goTo(annotation.location);
    void go?.catch((e) => toast.error(e.message));
  };
  useEffect(() => {
    // Follow a neoread:// link once the reader and annotations are ready.
    if (linkTarget?.id !== doc.id || !adapter || !annotationsLoaded) return;
    useReaderStore.getState().setLinkTarget(null);
    if (linkTarget.annotation) {
      const target = annotations.find((a) => a.id === linkTarget.annotation);
      if (target) {
        focusAnnotation(target);
        setRight(true);
        setRightTab("notes");
      } else toast.info("这条批注已不存在，已打开文档");
    } else if (linkTarget.page && doc.type === "pdf")
      void adapter
        .goTo({ type: "pdf", page: linkTarget.page })
        .catch((e) => toast.error(e.message));
  }, [linkTarget, adapter, annotationsLoaded, annotations, doc.id, doc.type]);
  const saveLocation = (next: DocumentLocation, percent: number) => {
    setTranslationSelection(null);
    setLocation(next);
    if (navigationRef.current?.settle()) setReturnLocation(undefined);
    if (next.type === "pdf") setPageInput(String(next.page));
    scheduleProgress(doc.id, { progress: next, percentage: percent }, (e) =>
      toast.error(e.message),
    );
  };
  const annotate = async (
    kind: Annotation["kind"],
    noteText = "",
    color = markColor,
  ) => {
    const written = kind === "note" || kind === "question";
    const source = written ? noteSelection : selection;
    const target =
      kind === "bookmark"
        ? (adapter?.getLocation() ?? location)
        : source?.location;
    if (!target || annotationSaving.current) return;
    annotationSaving.current = true;
    setNoteSaving(written);
    try {
      const prepared =
        source && kind !== "bookmark" && !editingAnnotation
          ? ((await adapter?.prepareAnnotation?.(source)) ?? source)
          : source;
      const a =
        written && editingAnnotation
          ? await api.updateAnnotationNote(
              doc.id,
              editingAnnotation.id,
              noteText,
            )
          : await api.annotate(doc.id, {
              kind,
              location:
                kind === "bookmark" ? target : (prepared?.location ?? target),
              quote: kind === "bookmark" ? "" : source?.text || "",
              note: noteText,
              color,
            });
      setAnnotations((items) => applySavedAnnotation(items, a));
      adapter?.clearSelection();
      if (kind === "bookmark")
        toast.success("已添加书签", { id: "neoread-annotation-save" });
      setNoteOpen(false);
      setNoteSelection(null);
      setEditingAnnotation(null);
      setNote("");
      return a;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      annotationSaving.current = false;
      setNoteSaving(false);
    }
  };
  useAnnotationUndo(
    doc.id,
    (items) => {
      setAnnotations(items);
      setAnnotationTarget(null);
      adapter?.clearSelection();
      setSelection(null);
    },
    () => !annotationsLoaded || annotationSaving.current || noteOpen,
  );

  const [hoveredAnnotation, setHoveredAnnotation] =
    useState<ReaderAnnotationTarget | null>(null);
  const selectedAnnotation = annotationTarget
    ? activeAnnotation(annotations, annotationTarget.ids)
    : undefined;
  const selectAnnotation = (target: ReaderAnnotationTarget | null) => {
    if (target) setTranslationSelection(null);
    setHoveredAnnotation(null);
    setAnnotationTarget(target);
    const annotation = target
      ? activeAnnotation(annotations, target.ids)
      : undefined;
    selectionClipboard.annotation(annotation);
  };
  const selectText = (next: ReaderSelection | null) => {
    if (next) {
      setHoveredAnnotation(null);
      setTranslationSelection(null);
    }
    setSelection(next);
    selectionClipboard.selection(next);
  };
  const editAnnotationNote = (annotation: Annotation) => {
    setHoveredAnnotation(null);
    setNoteKind(annotation.kind === "question" ? "question" : "note");
    setEditingAnnotation(annotation);
    setNoteSelection({ text: annotation.quote, location: annotation.location });
    setNote(annotation.note);
    setNoteOpen(true);
    adapter?.clearSelection();
  };
  const askAnnotationAI = (annotation: Annotation) => {
    const quote = { text: annotation.quote, location: annotation.location };
    setQuotes((items) =>
      [
        ...items.filter(
          (item) =>
            JSON.stringify(item.location) !== JSON.stringify(quote.location),
        ),
        quote,
      ].slice(-6),
    );
    setRight(true);
    setRightTab("ai");
    adapter?.clearSelection();
    requestAnimationFrame(() => composeInput.current?.focus());
  };
  const saveAnnotationText = async (
    annotation: Annotation,
    patch: { note: string; tags: string[] },
  ) => {
    try {
      const saved = await api.updateAnnotation(doc.id, annotation.id, patch);
      setAnnotations((items) => applySavedAnnotation(items, saved));
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  const recolor = async (annotation: Annotation, color: string) => {
    chooseColor(color);
    try {
      const saved = await api.updateAnnotation(doc.id, annotation.id, {
        color,
      });
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const resolveQuestion = async (annotation: Annotation, resolved: boolean) => {
    try {
      const saved = await api.updateAnnotation(doc.id, annotation.id, {
        resolved,
      });
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  /** Ask the AI and keep its saved answer linked to the question. */
  const answerQuestion = async (annotation: Annotation) => {
    if (answering.has(annotation.id)) return;
    setAnswering((ids) => new Set(ids).add(annotation.id));
    try {
      const answerId = await send(
        `请回答我在阅读时提出的问题：${annotation.note}\n回答时区分原文依据与你的推断。`,
        annotation.quote
          ? [{ text: annotation.quote, location: annotation.location }]
          : [],
        !annotation.quote,
      );
      if (!answerId) return;
      const saved = await api.updateAnnotation(doc.id, annotation.id, {
        answerId,
      });
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAnswering((ids) => {
        const next = new Set(ids);
        next.delete(annotation.id);
        return next;
      });
    }
  };
  const showAnswer = (messageId: string) => {
    setRight(true);
    setRightTab("ai");
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
        ?.scrollIntoView({ block: "start" }),
    );
  };
  const search = async () => {
    if (!adapter) return;
    const serial = ++searchSerial.current;
    setSearching(true);
    try {
      const found = await adapter.search(query.trim());
      if (serial === searchSerial.current) {
        setResults(found);
        setSearchedQuery(query.trim());
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      if (serial === searchSerial.current) setSearching(false);
    }
  };
  const openSearchResult = (result: SearchResult) => {
    const go = adapter?.focusLocation
      ? adapter.focusLocation(result.location)
      : adapter?.goTo(result.location);
    void go?.catch((error) => toast.error(error.message));
  };
  const addQuote = () => {
    if (selection) {
      setQuotes((items) => [...items, selection].slice(-6));
      setRight(true);
      setRightTab("ai");
      adapter?.clearSelection();
      setSelection(null);
    }
  };
  const send = async (
    question = prompt,
    selected = quotes,
    useSection = false,
    attachments = images,
    directImage = false,
  ) => {
    if (abort.current || session.getSnapshot().busy || aiModelSaving) return;
    if (!provider) {
      toast.info("请先在设置中选择 Agent SDK");
      onSettings();
      return;
    }
    if (!question.trim() && attachments.length)
      question = "请解释附件中的图表或公式。";
    if (!question.trim()) return;
    if (!session.getSnapshot().loaded) {
      toast.error("对话记录尚未加载，请重新加载。");
      return;
    }
    setSending(true);
    setRight(true);
    setRightTab("ai");
    const controller = new AbortController();
    abort.current = controller;
    const serial = ++sendSerial.current;
    try {
      const captured = await readingContext(
        adapter,
        provider,
        selected,
        useSection,
        attachments.length > 0,
      );
      const { context } = captured;
      if (controller.signal.aborted) return;
      if (!directImage) setPrompt("");
      await session.send({
        provider,
        webSearch,
        prompt: question,
        context,
        references: captured.references,
        readingLocation: captured.readingLocation,
        attachments,
      });
      if (serial !== sendSerial.current) return;
      const answer = session.getSnapshot().pending;
      if (
        !directImage &&
        ["saved", "syncing"].includes(
          session.getSnapshot().pending?.phase || "",
        )
      ) {
        setQuotes([]);
        setImages((current) =>
          current.filter(
            (image) => !attachments.some((sent) => sent.id === image.id),
          ),
        );
      }
      return answer?.phase === "saved" ? answer.savedId : undefined;
    } catch (e) {
      if (serial === sendSerial.current && (e as Error).name !== "AbortError")
        toast.error((e as Error).message);
    } finally {
      if (serial === sendSerial.current) {
        setSending(false);
        abort.current = null;
      }
    }
  };
  const regenerate = async () => {
    const current = useReaderStore.getState();
    if (abort.current || session.getSnapshot().busy || current.aiModelSaving)
      return;
    if (!provider) {
      onSettings();
      return;
    }
    const serial = ++sendSerial.current;
    setSending(true);
    try {
      await session.regenerate(provider);
    } catch (error) {
      if (serial === sendSerial.current) toast.error((error as Error).message);
    } finally {
      if (serial === sendSerial.current) setSending(false);
    }
  };
  const blockAction = (block: PDFBlock, action: PDFBlockAction) => {
    if (action === "copy") {
      if (block.image)
        void copyImage(
          blockImageURL(doc.id, block.id, block.image),
          (block.caption || block.text).trim(),
        );
      else void copyText(block.text.trim(), "已复制");
      return;
    }
    if (!block.image) {
      if (action === "explain")
        void send("请解释这段原文的含义，区分原文结论与你的补充说明。", [
          {
            text: block.text,
            location: {
              type: "pdf",
              page: block.page,
              quote: block.text,
              rects: [block.bounds],
            },
          },
        ]);
      return;
    }
    const image: ImageAttachment = {
      id: block.id,
      page: block.page,
      label: block.label,
      caption: block.caption,
    };
    if (action === "preview") {
      setPreviewImage(image);
      return;
    }
    if (sending) {
      toast.info("请等待当前回答完成");
      return;
    }
    setRight(true);
    setRightTab("ai");
    if (action === "explain") {
      void send(
        "请详细解释这张图表或公式，说明图中信息、符号及其在原文中的含义，区分事实与推断。",
        [],
        false,
        [image],
        true,
      );
      return;
    }
    if (images.some((item) => item.id === image.id)) {
      composeInput.current?.focus();
      return;
    }
    if (images.length >= 4) {
      toast.info("每次最多附加 4 张图片");
      return;
    }
    setImages((current) => [...current, image]);
    requestAnimationFrame(() => composeInput.current?.focus());
  };
  // EPUB paragraphs offer the PDF block actions; image blocks are served as
  // PNG under the same block image path.
  const epubBlockAction = (block: EPUBReadingBlock, action: PDFBlockAction) => {
    if (action === "copy") {
      if (block.image)
        void copyImage(blockImageURL(doc.id, block.id), block.text.trim());
      else void copyText(block.text.trim(), "已复制");
      return;
    }
    if (!block.image) {
      if (action === "explain")
        void send("请解释这段原文的含义，区分原文结论与你的补充说明。", [
          {
            text: block.text,
            location: { ...block.location, quote: block.text },
          },
        ]);
      return;
    }
    const image: ImageAttachment = {
      id: block.id,
      page: 0,
      label: block.label,
      caption: block.text || undefined,
    };
    if (action === "preview") {
      setPreviewImage(image);
      return;
    }
    if (action !== "explain") return;
    if (sending) {
      toast.info("请等待当前回答完成");
      return;
    }
    setRight(true);
    setRightTab("ai");
    void send(
      "请详细解释这张插图，说明图中信息及其在书中的含义，区分事实与推断。",
      [],
      false,
      [image],
      true,
    );
  };
  const imageAttachments = (items: ImageAttachment[], removable = false) => (
    <div className="image-attachments">
      {items.map((image) => (
        <div key={image.id} className="image-attachment">
          <Button
            className="attachment-preview"
            variant="ghost"
            aria-label={`查看附件：${imageLabel(image)}`}
            onClick={() => setPreviewImage(image)}
          >
            <img
              src={blockImageURL(doc.id, image.id)}
              alt={imageLabel(image)}
            />
            <span>{imageLabel(image)}</span>
          </Button>
          {removable && (
            <Button
              className="attachment-remove"
              variant="ghost"
              size="icon-xs"
              aria-label={`移除附件：${imageLabel(image)}`}
              onClick={() =>
                setImages((current) =>
                  current.filter((item) => item.id !== image.id),
                )
              }
            >
              <X />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
  const pageNavigation = (
    <div className="page-navigation">
      <IconButton
        label="上一页"
        onClick={() =>
          void adapter?.previous().catch((e) => toast.error(e.message))
        }
      >
        <ChevronLeft />
      </IconButton>
      {doc.type === "pdf" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const page = Number(pageInput);
            if (Number.isInteger(page) && page > 0) move({ type: "pdf", page });
          }}
        >
          <Input
            aria-label="跳转 PDF 页码"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            className="h-7 w-14 text-center"
          />
        </form>
      ) : null}
      <IconButton
        label="下一页"
        onClick={() =>
          void adapter?.next().catch((e) => toast.error(e.message))
        }
      >
        <ChevronRight />
      </IconButton>
    </div>
  );
  return (
    <div className="workspace">
      <header className="neoread-toolbar">
        <div className="neoread-title-group">
          <IconButton
            label="返回书库"
            onClick={() => {
              void flushProgress()
                .then(onBack)
                .catch((e) => toast.error(e.message));
            }}
          >
            <ArrowLeft />
          </IconButton>
          <IconButton
            label="目录与搜索"
            active={left}
            expanded={left}
            onClick={() => setLeft(!left)}
          >
            <PanelLeft />
          </IconButton>
          <span className="toolbar-divider" />
          <span className="neoread-title" title={doc.title}>
            {doc.title}
          </span>
          <Badge variant="secondary">{doc.type.toUpperCase()}</Badge>
        </div>
        <div className="toolbar-actions">
          {returnLocation && (
            <Button
              variant="outline"
              size="sm"
              disabled={referenceBusy}
              onClick={() => void returnFromReference()}
            >
              <ArrowLeft className="size-3" />
              返回阅读位置
            </Button>
          )}
          <IconButton label="文档概要" onClick={() => setOverviewOpen(true)}>
            <BookOpen />
          </IconButton>
          <div ref={setReadingToolbar} data-tour="reading-modes" />
          <span className="toolbar-divider" />
          <div ref={setSourceAutoCenterToolbar} />
          <IconButton
            label="添加书签"
            onClick={() => void annotate("bookmark")}
          >
            <BookmarkPlus />
          </IconButton>
          <Popover>
            <PopoverTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label="阅读外观" />
              }
            >
              <Type />
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <h3 className="text-sm font-medium">阅读外观</h3>
              <div className="space-y-4">
                <AppearancePicker theme={theme} setTheme={setTheme} />
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-sm">Agent 字号</span>
                  <Slider
                    className="reading-appearance-slider min-w-0 flex-1"
                    thumbLabel="Agent 字号"
                    min={80}
                    max={160}
                    step={5}
                    value={[Math.round(assistantSize * 100)]}
                    onValueChange={(value) =>
                      setTheme({
                        assistantFontScale:
                          (Array.isArray(value) ? value[0] : value) / 100,
                      })
                    }
                  />
                  <span className="w-10 text-right text-xs tabular-nums">
                    {Math.round(assistantSize * 100)}%
                  </span>
                </div>
                {doc.type === "epub" ? (
                  <>
                    <div className="setting-row">
                      <span>字号</span>
                      <Button
                        size="icon-xs"
                        variant="outline"
                        onClick={() =>
                          setTheme({
                            fontSize: Math.max(0.8, theme.fontSize - 0.1),
                          })
                        }
                      >
                        −
                      </Button>
                      <span>{Math.round(theme.fontSize * 100)}%</span>
                      <Button
                        size="icon-xs"
                        variant="outline"
                        onClick={() =>
                          setTheme({
                            fontSize: Math.min(2.4, theme.fontSize + 0.1),
                          })
                        }
                      >
                        +
                      </Button>
                    </div>
                    <div className="setting-row">
                      <span>行距</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setTheme({
                            lineHeight:
                              theme.lineHeight >= 2.2
                                ? 1.4
                                : Math.round((theme.lineHeight + 0.2) * 10) /
                                  10,
                          })
                        }
                      >
                        {theme.lineHeight.toFixed(1)}
                      </Button>
                      <span>页边距</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setTheme({
                            margin: theme.margin >= 64 ? 16 : theme.margin + 16,
                          })
                        }
                      >
                        {theme.margin}
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setTheme({
                            fontFamily:
                              theme.fontFamily === "serif"
                                ? "sans-serif"
                                : "serif",
                          })
                        }
                      >
                        {theme.fontFamily === "serif"
                          ? "宋体 / 衬线"
                          : "黑体 / 无衬线"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <span className="shrink-0 text-sm">原文缩放</span>
                      <Slider
                        className="reading-appearance-slider min-w-0 flex-1"
                        thumbLabel="原文缩放"
                        min={50}
                        max={300}
                        step={5}
                        value={[
                          typeof theme.zoom === "number"
                            ? Math.round(theme.zoom * 100)
                            : 100,
                        ]}
                        onValueChange={(value) =>
                          setTheme({
                            zoom:
                              (Array.isArray(value) ? value[0] : value) / 100,
                          })
                        }
                      />
                      <span className="w-10 text-right text-xs tabular-nums">
                        {typeof theme.zoom === "number"
                          ? `${Math.round(theme.zoom * 100)}%`
                          : "自动"}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setTheme({ zoom: "width" })}
                      >
                        适宽
                      </Button>
                    </div>
                  </>
                )}
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-sm">译文字号</span>
                  <Slider
                    className="reading-appearance-slider min-w-0 flex-1"
                    thumbLabel="译文字号"
                    min={80}
                    max={160}
                    step={5}
                    value={[Math.round(translationSize * 100)]}
                    onValueChange={(value) =>
                      setTheme({
                        translationFontSize:
                          (Array.isArray(value) ? value[0] : value) / 100,
                      })
                    }
                  />
                  <span className="w-10 text-right text-xs tabular-nums">
                    {Math.round(translationSize * 100)}%
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTheme({ translationFontSize: 1 })}
                  >
                    恢复
                  </Button>
                </div>
                <TranslationFontControls theme={theme} setTheme={setTheme} />
              </div>
            </PopoverContent>
          </Popover>
          <IconButton
            label="Agent 与批注"
            active={right}
            expanded={right}
            onClick={() => setRight(!right)}
          >
            <Sparkles />
          </IconButton>
          <IconButton label="设置" onClick={onSettings}>
            <Settings2 />
          </IconButton>
        </div>
      </header>
      <ResizablePanelGroup
        orientation="horizontal"
        className="neoread-panels"
        elementRef={panelGroup}
        defaultLayout={initialLayout.current}
        onLayoutChanged={(sizes, { isUserInteraction }) => {
          if (isUserInteraction) {
            updateReaderLayout({
              navigationOpen: sizes.navigation > 0,
              assistantOpen: sizes.assistant > 0,
              ...(sizes.navigation > 0
                ? { navigationWidth: sizes.navigation }
                : {}),
              ...(sizes.assistant > 0
                ? { assistantWidth: sizes.assistant }
                : {}),
            });
          }
        }}
        onPointerDownCapture={(event) => {
          if (
            (event.target as Element).closest('[data-slot="resizable-handle"]')
          ) {
            adapter?.cancelBlockFocus?.();
            panelGroup.current?.removeAttribute("data-toggling");
          }
        }}
      >
        <ResizablePanel
          id="navigation"
          panelRef={leftPanel}
          collapsible
          collapsedSize={0}
          style={{ overflow: "hidden" }}
          defaultSize="15%"
          minSize="180px"
          maxSize="30%"
        >
          <aside className="neoread-sidebar" data-open={left} inert={!left}>
            <Tabs
              value={leftTab}
              onValueChange={(value) => setLeftTab(String(value))}
              className="h-full gap-0"
            >
              <TabsList className="panel-tabs">
                <TabsTrigger value="toc">
                  <ListTree className="size-3.5" />
                  目录
                </TabsTrigger>
                <TabsTrigger value="search">
                  <Search className="size-3.5" />
                  搜索
                </TabsTrigger>
              </TabsList>
              <TabsContent value="toc" className="min-h-0 flex-1">
                <NavigationTree
                  key={doc.id}
                  documentId={doc.id}
                  type={doc.type}
                  outline={toc}
                  blocks={blocks}
                  annotations={annotations}
                  location={location}
                  go={move}
                  visible={active && left && leftTab === "toc"}
                />
              </TabsContent>
              <TabsContent value="search" className="min-h-0 flex-1 p-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void search();
                  }}
                  className="flex gap-1"
                >
                  <Input
                    aria-label="搜索文档"
                    ref={searchInput}
                    placeholder="搜索文档内容…"
                    value={query}
                    onChange={(e) => {
                      searchSerial.current++;
                      setQuery(e.target.value);
                      setResults([]);
                      setSearchedQuery("");
                      setSearching(false);
                    }}
                  />
                  <Button
                    size="icon"
                    variant="secondary"
                    disabled={searching}
                    aria-label="搜索"
                  >
                    <Search />
                  </Button>
                </form>
                <p className="my-3 text-xs text-muted-foreground">
                  {searching ? "正在搜索…" : `${results.length} 个结果`}
                </p>
                <ScrollArea className="h-[calc(100%-90px)]">
                  {results.map((result) => (
                    <Button
                      key={result.id}
                      variant="ghost"
                      className="search-result"
                      onClick={() => openSearchResult(result)}
                    >
                      <small>
                        {locationLabel(result.location)}
                        {result.side === "translation"
                          ? " · 译文"
                          : result.side === "source"
                            ? " · 原文"
                            : ""}
                      </small>
                      <span>{result.excerpt}</span>
                    </Button>
                  ))}
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </aside>
        </ResizablePanel>
        <ResizableHandle
          disabled={!left}
          className={left ? "" : "sidebar-handle-closed"}
        />
        <ResizablePanel id="reading" minSize="30%">
          <div className="reading-pane" ref={readingPane}>
            {(() => {
              const ReadingView =
                doc.type === "pdf" ? PDFReadingView : EPUBReadingView;
              return (
                <ReadingView
                  sidebarsOpen={{ left, right }}
                  document={doc}
                  theme={theme}
                  annotations={annotations}
                  blocks={blocks}
                  processing={processing}
                  toolbarHost={readingToolbar}
                  autoCenterHost={sourceAutoCenterToolbar}
                  pageNavigation={pageNavigation}
                  searchResults={results}
                  searchQuery={searchedQuery}
                  onReady={(engine, items) => {
                    setAdapter(engine);
                    setTOC(items);
                  }}
                  events={{
                    zoom: onZoom,
                    location: saveLocation,
                    selection: selectText,
                    annotation: selectAnnotation,
                    annotationHover: (target) =>
                      setHoveredAnnotation((current) =>
                        current &&
                        target &&
                        current.ids.join(",") === target.ids.join(",")
                          ? current
                          : target,
                      ),
                    linkPreview: setLinkPreview,
                    internalLink: (origin) => {
                      navigationRef.current?.remember(origin);
                      setReturnLocation(navigationRef.current?.origin);
                    },
                    blockAction,
                    epubBlockAction,
                  }}
                />
              );
            })()}
            {!selection && annotationTarget && selectedAnnotation && (
              <AnnotationToolbar
                annotation={selectedAnnotation}
                anchor={annotationTarget.anchor}
                pane={readingPane}
                deleting={deleting.has(selectedAnnotation.id)}
                onDelete={(id) => void removeAnnotation(id)}
                onNote={editAnnotationNote}
                onAskAI={askAnnotationAI}
                onAnswer={(annotation) => void answerQuestion(annotation)}
                onColor={(annotation, color) => void recolor(annotation, color)}
              />
            )}

            {selection?.anchor && (
              <SelectionToolbar anchor={selection.anchor} pane={readingPane}>
                <ColorSwatches
                  action="高亮"
                  onPick={(color) => {
                    chooseColor(color);
                    void annotate("highlight", "", color);
                  }}
                />
                <IconButton
                  label="下划线"
                  onClick={() => void annotate("underline")}
                >
                  <Underline />
                </IconButton>
                <IconButton
                  label="添加批注"
                  onClick={() => {
                    setNoteKind("note");
                    setEditingAnnotation(null);
                    setNoteSelection(selection);
                    setNote("");
                    setNoteOpen(true);
                    adapter?.clearSelection();
                  }}
                >
                  <StickyNote />
                </IconButton>
                <IconButton
                  label="提问"
                  onClick={() => {
                    setNoteKind("question");
                    setEditingAnnotation(null);
                    setNoteSelection(selection);
                    setNote("");
                    setNoteOpen(true);
                    adapter?.clearSelection();
                  }}
                >
                  <CircleHelp />
                </IconButton>
                <IconButton
                  label="问 AI"
                  onClick={() =>
                    void send(
                      "请解释这段文字的含义，区分原文结论与你的补充说明。",
                      [selection],
                    )
                  }
                >
                  <Sparkles />
                </IconButton>
                <IconButton label="引用到对话" onClick={addQuote}>
                  <Quote />
                </IconButton>
                <IconButton
                  label="划词翻译"
                  onClick={() => {
                    setTranslationSelection(selection);
                    setSelection(null);
                    adapter?.clearSelection();
                  }}
                >
                  <Languages />
                </IconButton>
              </SelectionToolbar>
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle
          disabled={!right}
          className={right ? "" : "sidebar-handle-closed"}
        />
        <ResizablePanel
          id="assistant"
          panelRef={rightPanel}
          collapsible
          collapsedSize={0}
          style={{ overflow: "hidden" }}
          defaultSize="25%"
          minSize="250px"
          maxSize="45%"
        >
          <aside
            className="assistant-sidebar"
            data-tour="assistant"
            data-open={right}
            inert={!right}
          >
            <Tabs
              value={rightTab}
              onValueChange={(value) => setRightTab(String(value))}
              className="h-full gap-0"
            >
              <TabsList className="panel-tabs">
                <TabsTrigger value="ai">
                  <Sparkles className="size-3.5" />
                  Agent
                </TabsTrigger>
                <TabsTrigger value="notes">
                  <StickyNote className="size-3.5" />
                  批注<small>{annotations.length || ""}</small>
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="聊天用量统计"
                  aria-label="聊天用量统计"
                  onClick={() => setUsageOpen(true)}
                >
                  <ChartColumn />
                </Button>
                {rightTab === "ai" && provider === "codex" && (
                  <CodexHandoffButton
                    key={doc.id}
                    documentId={doc.id}
                    sessionId={currentSession?.id}
                    disabled={
                      sending ||
                      !chat.loaded ||
                      !chat.messages.some(
                        (message) => message.role === "assistant",
                      )
                    }
                  />
                )}
              </TabsList>
              <TabsContent
                value="ai"
                className="ai-panel"
                style={
                  { "--assistant-font-scale": assistantSize } as CSSProperties
                }
              >
                <SessionPicker
                  documentId={doc.id}
                  sessions={sessions}
                  current={currentSession}
                  provider={provider}
                  running={sending}
                  onChange={selectSession}
                  onRefresh={refreshSessions}
                />
                {sessionError && (
                  <div
                    className="px-3 py-2 text-sm text-destructive"
                    role="alert"
                  >
                    {sessionError}
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() =>
                        void refreshSessions().catch((error) =>
                          toast.error(error.message),
                        )
                      }
                    >
                      重试
                    </Button>
                  </div>
                )}
                <AssistantPanel
                  key={currentSession?.id ?? doc.id}
                  session={session}
                  onRegenerate={() => void regenerate()}
                  regenerateDisabled={aiModelSaving || sending}
                  renderAnswer={(message, content) => (
                    <SourceReferences
                      key={message.id}
                      message={message}
                      toc={toc}
                      adapter={adapter}
                      onNavigate={visitReference}
                    >
                      {content}
                    </SourceReferences>
                  )}
                  empty={
                    <div className="chat-empty">
                      <p>
                        选中原文，可以翻译、解释，
                        <br />
                        或引用多段文字一起讨论。
                      </p>
                      <Button
                        variant="outline"
                        className="suggestion"
                        disabled={!adapter}
                        onClick={() =>
                          void send(
                            doc.type === "epub"
                              ? "请总结当前章节的核心内容，并列出值得思考的问题。"
                              : "请总结当前 PDF 页的主要内容，保留重要术语。",
                            [],
                            true,
                          )
                        }
                      >
                        <BookOpen />
                        总结当前{doc.type === "epub" ? "章节" : "页面"}
                        <ArrowLeft className="ml-auto rotate-180" />
                      </Button>
                      <Button
                        variant="outline"
                        className="suggestion"
                        disabled={!adapter}
                        onClick={() =>
                          void send(
                            "请找出当前内容的核心概念，并用简明的语言解释。",
                            [],
                            true,
                          )
                        }
                      >
                        <MessageSquare />
                        解释核心概念
                        <ArrowLeft className="ml-auto rotate-180" />
                      </Button>
                      <p className="privacy-note">
                        主动引用的文字和图片随问题发送；文档 Agent
                        按需检索、读取原文。
                      </p>
                    </div>
                  }
                  extras={(message) => (
                    <>
                      {!!message.attachments?.length &&
                        imageAttachments(message.attachments)}
                    </>
                  )}
                  references={(message) => (
                    <>
                      {message.readingLocation && (
                        <span
                          className="chat-reading-location"
                          title="提问时的阅读位置"
                        >
                          <BookOpen size={12} aria-hidden="true" />
                          {referenceLabel(message.readingLocation, toc)}
                        </span>
                      )}
                      <SourceReferences
                        message={message}
                        toc={toc}
                        adapter={adapter}
                        onNavigate={visitReference}
                      />
                    </>
                  )}
                />
                <div className="chat-compose" data-tour="compose">
                  {quotes.length > 0 && (
                    <div className="quote-chips">
                      {quotes.map((q, i) => (
                        <div key={i}>
                          <Quote size={12} />
                          <span>{q.text}</span>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label="移除引用"
                            onClick={() =>
                              setQuotes((items) =>
                                items.filter((_, j) => j !== i),
                              )
                            }
                          >
                            <X />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!!images.length && imageAttachments(images, true)}
                  <Textarea
                    ref={composeInput}
                    aria-label="向 AI 提问"
                    placeholder="问一个问题，或引用选中的文字…"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.altKey &&
                        !e.nativeEvent.isComposing &&
                        e.nativeEvent.keyCode !== 229
                      ) {
                        e.preventDefault();
                        if (!e.repeat && adapter && !sending) void send();
                      }
                    }}
                  />
                  <div className="compose-footer">
                    <ModelSelector
                      key={provider}
                      disabled={sending || !currentSession}
                      onSettings={onSettings}
                    />
                    {sending ? (
                      <Button
                        size="icon-sm"
                        variant="secondary"
                        aria-label="停止回答"
                        onClick={() => {
                          abort.current?.abort();
                          session.cancel();
                        }}
                      >
                        <Square className="size-3" />
                      </Button>
                    ) : (
                      <Button
                        size="icon-sm"
                        aria-label="发送问题"
                        disabled={
                          !adapter ||
                          aiModelSaving ||
                          !provider ||
                          (!prompt.trim() && !images.length)
                        }
                        onClick={() => void send()}
                      >
                        <Send className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="notes" className="notes-panel">
                <NotesPanel
                  document={doc}
                  annotations={annotations}
                  messages={chat.messages}
                  deleting={deleting}
                  answering={answering}
                  onGo={focusAnnotation}
                  onDelete={(id) => void removeAnnotation(id)}
                  onSave={saveAnnotationText}
                  onAnswer={(a) => void answerQuestion(a)}
                  onResolve={(a, resolved) => void resolveQuestion(a, resolved)}
                  onShowAnswer={showAnswer}
                  onExport={() => setExportingNotes(true)}
                  onRecover={async () => {
                    try {
                      const result = await api.recoverAnnotations(doc.id, true);
                      if (!result.checked) {
                        toast.error("请等待文档解析和翻译完成后再定位批注");
                        return;
                      }
                      const items = await api.annotations(doc.id);
                      if (recoveryDocument.current === doc.id)
                        setAnnotations(items);
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>

      <SelectionTranslation
        key={doc.id}
        selection={translationSelection}
        onClose={() => setTranslationSelection(null)}
      />
      <AnnotationHoverCard
        target={!selection && !noteOpen ? hoveredAnnotation : null}
        annotations={annotations}
        onEdit={editAnnotationNote}
      />
      <LinkPreviewPanel
        key={doc.id}
        preview={linkPreview}
        onDismiss={() => setLinkPreview(null)}
        onNavigate={(location) =>
          void visitReference(location, "").catch((error) =>
            toast.error(String(error)),
          )
        }
        renderKey={`${theme.mode}:${theme.pdfDarkContrast}`}
      />
      {previewImage && (
        <ImagePreview
          key={previewImage.id}
          documentId={doc.id}
          image={previewImage}
          renderImage={renderBlockImage}
          onClose={() => setPreviewImage(undefined)}
        />
      )}
      <Dialog
        open={noteOpen}
        onOpenChange={(open) => {
          if (noteSaving) return;
          setNoteOpen(open);
          if (!open) {
            setNoteSelection(null);
            setEditingAnnotation(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noteKind === "question"
                ? editingAnnotation
                  ? "编辑问题"
                  : "提问"
                : editingAnnotation?.note.trim()
                  ? "编辑批注"
                  : "添加批注"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {noteKind === "question"
                ? "就当前选区提问"
                : "为当前选区添加批注"}
            </DialogDescription>
          </DialogHeader>
          <blockquote className="note-preview">
            {noteSelection && (
              <AnnotationQuote
                quote={noteSelection.text}
                location={noteSelection.location}
              />
            )}
          </blockquote>
          <Textarea
            autoFocus
            placeholder={
              noteKind === "question" ? "想弄清楚什么？" : "批注内容…"
            }
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {noteKind === "question" ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void annotate("question", note)}
                disabled={noteSaving || !note.trim()}
              >
                <Check />
                保存问题
              </Button>
              {!editingAnnotation && (
                <Button
                  className="flex-1"
                  disabled={noteSaving || !note.trim() || !provider}
                  onClick={() =>
                    void annotate("question", note).then((saved) => {
                      if (saved) void answerQuestion(saved);
                    })
                  }
                >
                  <Sparkles />
                  保存并让 AI 回答
                </Button>
              )}
            </div>
          ) : (
            <Button
              onClick={() => void annotate("note", note)}
              disabled={
                noteSaving || (!note.trim() && !editingAnnotation?.note.trim())
              }
            >
              <Check />
              保存批注
            </Button>
          )}
        </DialogContent>
      </Dialog>
      {exportingNotes && (
        <ExportDocumentDialog
          key={`export-${doc.id}`}
          document={doc}
          annotations={annotations}
          messages={chat.messages}
          link={(a) => neoreadLink({ id: doc.id, annotation: a.id })}
          onClose={() => setExportingNotes(false)}
        />
      )}
      <DocumentOverviewDialog
        key={doc.id}
        document={overviewOpen ? doc : null}
        onClose={() => setOverviewOpen(false)}
        onNavigate={async (location) => {
          await adapter?.goTo(location);
        }}
      />
      <ProcessingUsageDialog
        document={usageOpen ? doc : null}
        onClose={() => setUsageOpen(false)}
      />
    </div>
  );
}
