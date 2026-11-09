import { useAnnotationUpdates } from "./useAnnotationUpdates";
import { webSearchEnabled } from "./chat/web-search";
import { NavigationTree } from "./NavigationTree";
import { label, useBindings, useShortcut } from "./shortcuts/shortcuts";
import { registerTabCloseGuard } from "./document-tab-guards";
import { useDocumentTheme } from "./useDocumentTheme";
import {
  readerLayout,
  sidebarLayout,
  updateReaderLayout,
} from "./neoread-layout";
import { SelectionTranslation } from "./SelectionTranslation";
import { SearchResultText } from "./SearchResultText";
import { LinkPreviewPanel } from "./LinkPreviewPanel";
import { AnnotationHoverCard } from "./AnnotationHoverCard";
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
  type SelectionAnchor,
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
import { PaperNote } from "./PaperNote";
import { ExportDocumentDialog } from "./ExportDocumentDialog";
import { EPUBReadingView } from "./translation/EPUBReadingView";
import { PDFReadingView } from "./translation/PDFReadingView";
import { useReaderStore } from "./store";
import { scheduleProgress, flushProgress } from "./progress";
import { pdfModeLocation, savePDFProgress } from "./pdf-progress";
import { ReadingTextControls } from "./ReadingTextControls";
import { translationFont } from "./appearance";
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
  const assistantSize = theme.assistantFontScale ?? 1;
  const assistantFamily = theme.assistantFontFamily ?? "sans-serif";
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
    doc.progress?.type === "pdf"
      ? pdfModeLocation(doc.progress, theme.textReflow === true)
      : doc.progress,
  );
  const lastReadingLocation = useRef(doc.progress);
  const pdfProgress = useRef(
    doc.progress?.type === "pdf" ? doc.progress : undefined,
  );
  const resumeReading = useRef(false);
  useEffect(() => {
    if (!active) {
      resumeReading.current = true;
      return;
    }
    const position =
      doc.type === "pdf"
        ? pdfModeLocation(pdfProgress.current, theme.textReflow === true)
        : lastReadingLocation.current;
    if (resumeReading.current && adapter) {
      resumeReading.current = false;
      if (position)
        void adapter.goTo(position).catch((e) => toast.error(e.message));
    }
  }, [active, adapter, doc.type, theme.textReflow]);
  const [translationSelection, setTranslationSelection] =
    useState<ReaderSelection | null>(null);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
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
  const [rightTab, setRightTab] = useState("ai");
  const [leftTab, setLeftTab] = useState("toc");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState("");
  const [noteAnchor, setNoteAnchor] = useState<SelectionAnchor | null>(null);
  const noteOpen = !!noteAnchor;
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
  useEffect(() => {
    if (doc.type !== "pdf") return;
    const position = pdfModeLocation(
      pdfProgress.current,
      theme.textReflow === true,
    );
    setLocation(position);
    setPageInput(String(position?.page ?? 1));
  }, [doc.id, doc.type, theme.textReflow]);
  const abort = useRef<AbortController | null>(null);
  const searchSerial = useRef(0);
  useEffect(() => {
    searchSerial.current++;
    setQuery("");
    setResults([]);
    setSearchedQuery("");
    setSearching(false);
  }, [doc.id]);
  useAnnotationUpdates(
    doc.id,
    (items) => {
      setAnnotations(items);
      setAnnotationsLoaded(true);
    },
    () => {
      setAnnotations([]);
      setAnnotationsLoaded(false);
    },
    active,
  );
  useShortcut("readerLeft", () => setLeft(!left), active);
  useShortcut("readerRight", () => setRight(!right), active);
  const bindings = useBindings();
  useShortcut(
    "returnLocation",
    () => {
      if (returnLocation && !referenceBusy) void returnFromReference();
    },
    active && !!returnLocation,
  );
  useShortcut(
    "search",
    () => {
      setLeft(true);
      setLeftTab("search");
      requestAnimationFrame(() => searchInput.current?.focus());
    },
    active,
  );
  useEffect(() => {
    session.activate();
    abort.current = null;
    if (currentSession) void session.load();
    setSending(false);
    return () => {
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
    if (!active) return;
    lastReadingLocation.current = next;
    setTranslationSelection(null);
    setLocation(next);
    if (navigationRef.current?.settle()) setReturnLocation(undefined);
    if (next.type === "pdf") setPageInput(String(next.page));
    if (next.type === "pdf")
      pdfProgress.current = savePDFProgress(
        pdfProgress.current,
        next,
        theme.textReflow === true,
      );
    scheduleProgress(
      doc.id,
      {
        progress: next.type === "pdf" ? pdfProgress.current! : next,
        percentage: percent,
      },
      (e) => toast.error(e.message),
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
      setNoteAnchor(null);
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
    () => !active || !annotationsLoaded || annotationSaving.current || noteOpen,
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
  const editAnnotationNote = (
    annotation: Annotation,
    anchor: SelectionAnchor,
  ) => {
    setHoveredAnnotation(null);
    setNoteKind(annotation.kind === "question" ? "question" : "note");
    setEditingAnnotation(annotation);
    setNoteSelection({ text: annotation.quote, location: annotation.location });
    setNote(annotation.note);
    setNoteAnchor(anchor);
    adapter?.clearSelection();
  };
  // Removes only the note; the highlight stays and Cmd+Z restores the text.
  const deleteAnnotationNote = async (annotation: Annotation) => {
    if (annotationSaving.current) return;
    annotationSaving.current = true;
    try {
      const saved = await api.updateAnnotationNote(doc.id, annotation.id, "");
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      annotationSaving.current = false;
    }
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
  const updateSearchQuery = (value: string) => {
    searchSerial.current++;
    setQuery(value);
    setResults([]);
    setSearchedQuery("");
    setSearching(false);
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
  const closeState = useRef({ busy: false, draft: false, saving: false });
  closeState.current = {
    busy: chat.busy || sending,
    draft:
      !!prompt.trim() ||
      quotes.length > 0 ||
      images.length > 0 ||
      (noteOpen && !!note.trim()),
    saving: noteSaving || annotationSaving.current,
  };
  useEffect(
    () =>
      registerTabCloseGuard(doc.id, () => {
        if (closeState.current.saving)
          return {
            blocked: true,
            message: "批注正在保存，请保存完成后再关闭。",
          };
        if (closeState.current.busy || closeState.current.draft)
          return {
            message:
              "关闭后会清除未发送的问题、附件和未保存的批注。已保存的阅读记录与对话会保留，后台回答会继续，可重新打开查看。",
          };
        return null;
      }),
    [doc.id],
  );
  useEffect(() => {
    if (active) return;
    adapter?.clearSelection();
    setSelection(null);
    setTranslationSelection(null);
    setLinkPreview(null);
    setAnnotationTarget(null);
    void flushProgress().catch((e) => toast.error(e.message));
  }, [active, adapter]);
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
          <IconButton label="文档概要" onClick={() => setOverviewOpen(true)}>
            <BookOpen />
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
              title={`返回阅读位置（${label(bindings.returnLocation)}）`}
              onClick={() => void returnFromReference()}
            >
              <ArrowLeft className="size-3" />
              返回阅读位置
            </Button>
          )}
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
                <ReadingTextControls
                  theme={theme}
                  setTheme={setTheme}
                  docType={doc.type}
                />
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
                />
              </TabsContent>
              <TabsContent
                value="search"
                className="relative flex min-h-0 flex-1 flex-col gap-3 p-3"
              >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void search();
                  }}
                  className="flex shrink-0 gap-1"
                >
                  <div className="relative min-w-0 flex-1">
                    <Input
                      aria-label="搜索文档"
                      ref={searchInput}
                      className="pr-8"
                      placeholder="搜索文档内容…"
                      value={query}
                      onChange={(e) => updateSearchQuery(e.target.value)}
                    />
                    {query && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="清空搜索"
                        className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                        onClick={() => {
                          updateSearchQuery("");
                          searchInput.current?.focus();
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                  <Button
                    size="icon"
                    variant="secondary"
                    disabled={searching}
                    aria-label="搜索"
                  >
                    <Search />
                  </Button>
                </form>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="pb-12">
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
                        <span>
                          <SearchResultText
                            text={result.excerpt}
                            query={searchedQuery}
                          />
                        </span>
                      </Button>
                    ))}
                  </div>
                </ScrollArea>
                <p
                  role="status"
                  className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 text-xs whitespace-nowrap text-muted-foreground shadow-sm"
                >
                  {searching ? "正在搜索…" : `${results.length} 个结果`}
                </p>
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
                  active={active}
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
                onNote={(annotation) =>
                  editAnnotationNote(annotation, annotationTarget.anchor)
                }
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
                    setNoteAnchor(selection.anchor!);
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
                    setNoteAnchor(selection.anchor!);
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
                <TabsTrigger value="paper-note">
                  <BookOpen className="size-3.5" />
                  笔记
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="ai"
                className="ai-panel"
                style={
                  {
                    "--assistant-font-scale": assistantSize,
                    // Unset variables leave the interface font and weight.
                    ...(assistantFamily !== "sans-serif" && {
                      "--assistant-font-family":
                        translationFont(assistantFamily),
                    }),
                    ...(theme.assistantFontWeight === "bold" && {
                      "--assistant-font-weight": 600,
                    }),
                  } as CSSProperties
                }
              >
                <SessionPicker
                  documentId={doc.id}
                  sessions={sessions}
                  current={currentSession}
                  provider={provider}
                  continueAction={
                    provider === "codex" && (
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
                    )
                  }
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
                />
              </TabsContent>
              <TabsContent
                value="paper-note"
                keepMounted
                className="paper-note-panel"
              >
                <PaperNote
                  key={doc.id}
                  documentId={doc.id}
                  annotations={annotations}
                  active={active && rightTab === "paper-note"}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>

      <SelectionTranslation
        key={doc.id}
        selection={active ? translationSelection : null}
        onClose={() => setTranslationSelection(null)}
      />
      <AnnotationHoverCard
        target={active && !selection && !noteOpen ? hoveredAnnotation : null}
        annotations={annotations}
        editor={
          active && noteAnchor
            ? {
                anchor: noteAnchor,
                kind: noteKind,
                editing: !!editingAnnotation,
                initial: editingAnnotation?.note ?? "",
                value: note,
                saving: noteSaving,
                canAnswer: !!provider,
                onChange: setNote,
                onSave: () => void annotate(noteKind, note),
                onSaveAndAnswer: () =>
                  void annotate("question", note).then((saved) => {
                    if (saved) void answerQuestion(saved);
                  }),
                onClose: () => {
                  setNoteAnchor(null);
                  setNoteSelection(null);
                  setEditingAnnotation(null);
                },
              }
            : null
        }
        onEdit={editAnnotationNote}
        onDelete={(annotation) => void deleteAnnotationNote(annotation)}
      />
      <LinkPreviewPanel
        key={doc.id}
        preview={active ? linkPreview : null}
        onDismiss={() => setLinkPreview(null)}
        onNavigate={(location) =>
          void visitReference(location, "").catch((error) =>
            toast.error(String(error)),
          )
        }
        renderKey={`${theme.mode}:${theme.pdfDarkContrast}`}
      />
      {active && previewImage && (
        <ImagePreview
          key={previewImage.id}
          documentId={doc.id}
          image={previewImage}
          renderImage={renderBlockImage}
          onClose={() => setPreviewImage(undefined)}
        />
      )}
      {active && exportingNotes && (
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
        document={active && overviewOpen ? doc : null}
        onClose={() => setOverviewOpen(false)}
        onNavigate={async (location) => {
          await adapter?.goTo(location);
        }}
      />
    </div>
  );
}
