import { figureTarget } from "../readers/figure-references";
import { readerLayout, updateReaderLayout } from "../neoread-layout";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslations } from "./useTranslations";
import { createPortal } from "react-dom";
import { Crosshair } from "lucide-react";
import type {
  Annotation,
  Document as ReaderDocument,
  DocumentLocation,
  PDFBlock,
  PDFReadingAnchor,
  Processing,
  ReaderAdapter,
  ReaderEvents,
  ReaderSelection,
  ReaderTheme,
  SearchResult,
  TOCItem,
  TranslationBlock,
} from "@neoread/core";
import { defaultTheme, isPDFPageDecoration } from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";
import { Popover, PopoverContent } from "@neoread/ui/components/popover";
import { toast } from "sonner";
import { ReaderView } from "../ReaderView";
import { overlap, ReadingSync } from "../readers/pdf-reading";
import { animatePDFScroll } from "../readers/pdf-scroll";
import { TranslationPanes } from "./TranslationPanes";
import { formulaNumbers } from "./formulaNumbers";
import {
  ReflowSource,
  showsOriginal,
  TranslationText,
} from "./TranslationText";
import { reflowBlockText, restoredSource } from "./reflow";
import { reflowSourceSelection } from "./reflow-selection";
import { flashReflowReference } from "./reflow-reference";
import { copyText } from "../chat/clipboard";
import { EPUBBlockOverlay } from "../readers/epub-block-focus";
import { DeferredBlockFocus } from "../readers/deferred-block-focus";
import { blockImageCache } from "./block-images";
import { useSentenceMarks } from "./useSentenceMarks";
import {
  selectedSideText,
  translatedSelection as captureTranslationSelection,
} from "./selection";
import { installTranslationSelectionHighlight } from "./selection-highlight";
import { sourceFont, translationFont } from "../appearance";
import { selectSentence } from "../readers/sentence-selection";
import { installCitationHover } from "../readers/citation-hover";
import { numberedReference } from "../readers/pdf-citations";
import "./translation.css";

import { AssistanceControls } from "./AssistanceControls";
import { BookChapterControls } from "./BookChapterControls";
import { chapterRange, chapterTitle, headingPages } from "./chapters";
import { useChapterTranslation } from "./chapterTranslation";
import { searchPDFBlocks } from "./pdf-search";

import type { ReadingMode } from "./reading-mode";
/** Scroll settling after a pinned jump or click does not move the chapter. */
const pinHold = 800;
const noTranslations: TranslationBlock[] = [];
export function PDFReadingView({
  document: doc,
  active = true,
  theme,
  readingMode,
  onReadingModeChange,
  annotations,
  blocks,
  processing,
  toolbarHost,
  autoCenterHost,
  pageNavigation,
  searchResults = [],
  searchQuery = "",
  onReady,
  events,
}: {
  document: ReaderDocument;
  active?: boolean;
  theme: ReaderTheme;
  readingMode: ReadingMode;
  onReadingModeChange: (mode: ReadingMode) => void;
  annotations: Annotation[];
  blocks: PDFBlock[];
  processing?: Processing;
  toolbarHost?: HTMLElement | null;
  /** Where the sync toggle renders; null hides it, undefined keeps it in the toolbar. */
  autoCenterHost?: HTMLElement | null;
  pageNavigation?: ReactNode;
  sidebarsOpen?: { left: boolean; right: boolean };
  searchResults?: SearchResult[];
  searchQuery?: string;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  events: ReaderEvents;
}) {
  const { swapped, sourceWidth } = readerLayout(theme.readerLayout);
  // The PDF engine stays mounted, hidden, for outline, search and navigation.
  const reflow = theme.textReflow === true;
  const blockSelector = reflow
    ? "[data-reflow-block]"
    : "[data-translation-block]";
  const nodeBlockId = (node: HTMLElement) =>
    reflow ? node.dataset.reflowBlock : node.dataset.translationBlock;
  const mode = readingMode === "reflow" ? "parallel" : readingMode;
  const paneMode = reflow ? "translation" : mode;
  const [syncEnabled, setSyncEnabled] = useState(true);
  const layoutRevision = processing?.layoutRevision;
  const { translations: streamed, error } = useTranslations(
    doc.id,
    undefined,
    active,
    layoutRevision,
  );
  const [blockLayout, setBlockLayout] = useState({ blocks, layoutRevision });
  if (blockLayout.blocks !== blocks) setBlockLayout({ blocks, layoutRevision });
  const translations =
    blockLayout.layoutRevision === layoutRevision ? streamed : noTranslations;
  const [popup, setPopup] = useState<{ block: PDFBlock; rect: DOMRect }>();
  const [engine, setEngine] = useState<ReaderAdapter>();
  const [hoveredBlock, setHoveredBlock] = useState<string>();
  const [focusedBlock, setFocusedBlock] = useState<string>();
  const deferredFocus = useMemo(() => new DeferredBlockFocus(), []);
  useEffect(() => {
    const cancel = () => deferredFocus.cancel();
    document.addEventListener("pointerdown", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      deferredFocus.cancel();
    };
  }, [deferredFocus]);
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const hover = (origin: "source" | "translation", blockId?: string) => {
    if (reflow) return;
    if (!blockId && hoverOwner.current !== origin) return;
    hoverOwner.current = blockId ? origin : undefined;
    setHoveredBlock(blockId);
    engine?.hoverBlock?.(
      mode === "parallel" && origin === "translation"
        ? (blockId ?? null)
        : null,
    );
  };
  const previousMode = useRef<ReadingMode>(readingMode);
  const syncEnabledRef = useRef(syncEnabled);
  syncEnabledRef.current = syncEnabled;
  const explicitFocus = useRef({
    operation: 0,
    moving: false,
  });
  const root = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLDivElement>(null),
    control = useRef(new ReadingSync()),
    side = useRef<"source" | "translation">("source"),
    reading = useRef<PDFReadingAnchor | undefined>(undefined);
  const pendingRestore = useRef(true);
  const progressSeeded = useRef(false);
  // The page whose chapter the book toolbar describes. A click or jump pins
  // it; afterwards scrolling moves it to the paragraph mid-view.
  const [chapterPage, setChapterPage] = useState(
    doc.progress?.type === "pdf" ? doc.progress.page : 1,
  );
  const pinnedAt = useRef(0);
  const pageTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinPage = (page: number) => {
    pinnedAt.current = performance.now();
    clearTimeout(pageTimer.current);
    setChapterPage(page);
  };
  const driftPage = (page: number) => {
    if (performance.now() - pinnedAt.current < pinHold) return;
    clearTimeout(pageTimer.current);
    pageTimer.current = setTimeout(() => setChapterPage(page), 200);
  };
  useEffect(() => () => clearTimeout(pageTimer.current), []);
  const recordReading = (anchor: PDFReadingAnchor) => {
    const block = state.current?.blocks.find((b) => b.id === anchor.blockId);
    if (block) driftPage(block.page);
    reading.current = anchor;
    progressSeeded.current = true;
  };
  const blockLocation = (block: PDFBlock, fraction = 0.5) => ({
    type: "pdf" as const,
    page: block.page,
    x: block.bounds.x,
    y: block.bounds.y + fraction * block.bounds.height,
    reflowPosition: { page: block.page, blockId: block.id },
    ...(state.current.reflow ? { reflowBlockId: block.id } : {}),
  });
  const publishReading = (anchor: PDFReadingAnchor) => {
    const block = state.current.blocks.find((b) => b.id === anchor.blockId);
    if (!block) return;
    state.current.events.location(
      blockLocation(block, anchor.fraction),
      block.page /
        (engine?.getPageCount?.() ||
          Math.max(1, ...state.current.blocks.map((b) => b.page))),
    );
  };
  const translationMotion = useRef({
    operation: 0,
    moving: false,
    blockId: "",
  });
  const pressedBlock = useRef<{ id: string; x: number; y: number } | undefined>(
    undefined,
  );
  const cancelTranslationMotion = () => {
    translationMotion.current.operation++;
    translationMotion.current.moving = false;
  };
  useLayoutEffect(() => {
    if (!active) return;
    const host = pane.current;
    if (!host) return;
    // Measure the panel, not the pane: the pane's own half-height padding
    // would keep it from shrinking when the panel gets shorter.
    const frame = host.parentElement ?? host;
    let initialized = false;
    const resize = () => {
      const node = Array.from(
        host.querySelectorAll<HTMLElement>(blockSelector),
      ).find((node) => nodeBlockId(node) === reading.current?.blockId);
      const before = node?.getBoundingClientRect().top;
      host.style.setProperty(
        "--translation-inset",
        `${frame.clientHeight / 2}px`,
      );
      if (initialized && node && before !== undefined)
        host.scrollTop += node.getBoundingClientRect().top - before;
      initialized = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      cancelTranslationMotion();
    };
  }, [mode, doc.id, active, reflow]);
  const state = useRef({ mode, blocks, translations, events, theme, reflow });
  state.current = { mode, blocks, translations, events, theme, reflow };
  useSentenceMarks(
    root,
    engine,
    blocks,
    translations,
    annotations,
    theme.linkTranslationAnnotations !== false,
    mode,
    events,
    searchQuery,
    searchResults,
  );
  const byId = useMemo(
    () => new Map(translations.map((t) => [t.blockId, t])),
    [translations],
  );
  const selecting = useRef(false),
    selection = useRef<ReaderSelection | null>(null),
    scrollFrame = useRef(0);
  const equationNumbers = useMemo(() => formulaNumbers(blocks), [blocks]);
  const imageTheme = `${theme.mode}:${theme.pdfDarkContrast ?? "soft"}`;
  const [imageCache, setImageCache] = useState<{
    theme: string;
    cache: ReturnType<typeof blockImageCache>;
  }>();
  useEffect(() => {
    if (!engine?.renderBlockImage) return;
    const imageThemeSnapshot = { ...theme };
    const cache = blockImageCache((id, signal, width) =>
      engine.renderBlockImage!(id, signal, width, imageThemeSnapshot),
    );
    setImageCache({ theme: imageTheme, cache });
    return () => cache.dispose();
  }, [engine, blocks, imageTheme]);
  const blockImages =
    imageCache?.theme === imageTheme ? imageCache.cache : undefined;
  const imageKey = `${imageTheme}:${blockImages ? "ready" : "pending"}`;
  const visibleBlocks = blocks.filter(
    (b) => !isPDFPageDecoration(b) && !equationNumbers.pairedIds.has(b.id),
  );
  const searchBlockIds = useMemo(
    () => [
      ...new Set(
        searchResults
          .map((result) => result.blockId)
          .filter((id): id is string => !!id),
      ),
    ],
    [searchResults],
  );
  useEffect(() => {
    engine?.setSearchBlocks?.(searchBlockIds);
  }, [engine, searchBlockIds]);
  useEffect(() => {
    if (pane.current) return installTranslationSelectionHighlight(pane.current);
  }, [mode, doc.id]);
  const translate = async (blockId: string) => {
    try {
      await api.translate(doc.id, blockId, true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const targetNode = (id: string) =>
    Array.from(
      pane.current?.querySelectorAll<HTMLElement>(blockSelector) ?? [],
    ).find((n) => nodeBlockId(n) === id);
  const followTranslation = (
    anchor: PDFReadingAnchor,
    sentenceIndex?: number,
    options: { smooth?: boolean; center?: boolean } = {},
  ) => {
    const node = targetNode(anchor.blockId),
      host = pane.current;
    if (!node || !host) return;
    control.current.following("translation");
    const target =
      sentenceIndex === undefined
        ? node
        : (node.querySelector<HTMLElement>(
            `[data-sentence="${sentenceIndex}"]`,
          ) ?? node);
    const r = target.getBoundingClientRect(),
      v = host.getBoundingClientRect();
    const top =
      host.scrollTop +
      r.top -
      v.top -
      (options.center
        ? Math.max(0, (v.height - r.height) / 2)
        : v.height * 0.5 -
          (sentenceIndex === undefined ? r.height * anchor.fraction : 0));
    if (
      translationMotion.current.moving &&
      translationMotion.current.blockId === anchor.blockId &&
      !options.center
    )
      return;
    cancelTranslationMotion();
    if (!options.smooth) {
      host.scrollTop = top;
      return;
    }
    const motion = translationMotion.current;
    const operation = motion.operation;
    motion.moving = true;
    motion.blockId = anchor.blockId;
    return animatePDFScroll(
      host,
      options.center
        ? host.scrollLeft + r.left - v.left + r.width / 2 - host.clientWidth / 2
        : host.scrollLeft,
      top,
      () => operation !== motion.operation || pane.current !== host,
      () => {},
    ).finally(() => {
      if (operation === motion.operation) {
        motion.moving = false;
        // Ignore the last programmatic scroll event; fresh input releases this.
        control.current.following("translation");
      }
    });
  };
  const focusBlock = (block: PDFBlock, origin: "source" | "translation") => {
    input(origin);
    const motion = explicitFocus.current;
    const operation = motion.operation;
    motion.moving = true;
    setFocusedBlock(block.id);
    const anchor = { blockId: block.id, fraction: 0.5 };
    pinPage(block.page);
    recordReading(anchor);
    // Both panels center their own geometry; a tall translation must not shift
    // a short original away from its center (or vice versa).
    const source =
      mode !== "translation" && !reflow
        ? engine?.focusBlock?.(block.id, mode)
        : undefined;
    const translated =
      mode !== "source" || reflow
        ? followTranslation(anchor, undefined, { smooth: true, center: true })
        : undefined;
    const completed = Promise.all([source, translated])
      .catch((e) => toast.error(e.message))
      .finally(() => {
        if (operation === motion.operation) {
          motion.moving = false;
          setFocusedBlock(undefined);
          control.current.following(origin);
        }
      });
    events.location(
      blockLocation(block),
      block.page /
        (engine?.getPageCount?.() || Math.max(1, ...blocks.map((b) => b.page))),
    );
    return completed;
  };
  const focusTranslation = (block: PDFBlock) => {
    void focusBlock(block, "translation");
  };
  const locationBlock = (location: DocumentLocation) => {
    if (location.type !== "pdf") return;
    const readable = state.current.blocks.filter(
      (b) => !isPDFPageDecoration(b),
    );
    const linked =
      (location.reflowPosition?.page === location.page
        ? location.reflowPosition.blockId
        : undefined) ??
      location.reflowBlockId ??
      location.translation?.blockId ??
      location.sourceAnchors?.[0]?.blockId ??
      location.sentenceLink?.parts[0]?.blockId;
    const page = readable.filter((b) => b.page === location.page);
    // Saved selections carry rects rather than x/y; the first marked line
    // decides the paragraph, never the page origin.
    const rect = location.rects?.[0] ?? location.sourceAnchors?.[0]?.bounds;
    const covering =
      rect &&
      page
        .map((b) => ({ block: b, area: overlap(rect, b.bounds) }))
        .filter((c) => c.area > 0)
        .sort((a, b) => b.area - a.area)[0]?.block;
    const x = location.x ?? (rect ? rect.x + rect.width / 2 : 0),
      y = location.y ?? (rect ? rect.y + rect.height / 2 : 0);
    return (
      readable.find((b) => b.id === linked) ??
      covering ??
      page.sort((a, b) => {
        const distance = (block: PDFBlock) =>
          Math.max(
            block.bounds.y - y,
            y - block.bounds.y - block.bounds.height,
            0,
          ) +
          Math.max(
            block.bounds.x - x,
            x - block.bounds.x - block.bounds.width,
            0,
          ) *
            2;
        return distance(a) - distance(b);
      })[0]
    );
  };
  const go = async (location: DocumentLocation) => {
    input(mode === "translation" || reflow ? "translation" : "source");
    const operation = explicitFocus.current.operation;
    if (location.type === "pdf") pinPage(location.page);
    if (location.type !== "pdf") return;
    const block = locationBlock(location);
    if (block) {
      const anchor = {
        blockId: block.id,
        fraction:
          location.y === undefined
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  (location.y - block.bounds.y) / (block.bounds.height || 1),
                ),
              ),
      };
      recordReading(anchor);
      followTranslation(anchor, location.translation?.sentenceIndexes[0]);
      publishReading(anchor);
    } else {
      reading.current = undefined;
      progressSeeded.current = true;
      state.current.events.location(
        location,
        location.page /
          (engine?.getPageCount?.() ||
            Math.max(1, ...state.current.blocks.map((b) => b.page))),
      );
    }
    if (!reflow) {
      explicitFocus.current.moving = true;
      try {
        await engine?.goTo(location);
      } finally {
        if (operation === explicitFocus.current.operation)
          explicitFocus.current.moving = false;
      }
    }
  };
  const focus = async (location: DocumentLocation) => {
    const block = locationBlock(location);
    const completed = block
      ? focusBlock(
          block,
          mode === "translation" || reflow ? "translation" : "source",
        )
      : go(location);
    const operation = explicitFocus.current.operation;
    await completed;
    if (operation !== explicitFocus.current.operation) return;
    if (
      location.type === "pdf" &&
      !(location.translation && location.quoteContext) &&
      mode !== "translation" &&
      !reflow
    )
      engine?.flashReference?.(location, location.quote ?? "");
  };
  // Keep the public adapter usable by TOC, notes and page navigation in all modes.
  const facade = useRef<ReaderAdapter | undefined>(undefined);
  const outline = useRef<TOCItem[]>([]);
  // The PDF engine is hidden while reflowed; mark the visible source text.
  const flash = (location: DocumentLocation, text: string) => {
    const block = location.type === "pdf" && locationBlock(location);
    if (block && pane.current)
      flashReflowReference(pane.current, block.id, location.quote || text);
  };
  const actions = useRef({ go, focus, flash });
  actions.current = { go, focus, flash };
  useEffect(() => {
    if (!root.current || !engine) return;
    return installCitationHover(
      root.current,
      async (blockId, label) => {
        if (label.startsWith("figure:")) {
          const block = figureTarget(blocks, label.slice(7));
          return block
            ? {
                type: "pdf" as const,
                page: block.page,
                x: block.bounds.x,
                y: block.bounds.y,
              }
            : undefined;
        }
        return (
          (await engine.resolveCitation?.(blockId, label)) ??
          numberedReference(blocks, label)
        );
      },
      async (location, anchor) => {
        await engine.previewCitation?.(location, anchor);
      },
      () => engine.hideCitationPreview?.(),
    );
  }, [engine, blocks, mode]);
  // Reflowed paragraphs share the EPUB paragraph box: hover outline, copy and
  // ask-AI actions, and an optional click-to-focus movement.
  const overlay = useRef<EPUBBlockOverlay<PDFBlock> | undefined>(undefined);
  useEffect(() => {
    const host = pane.current;
    if (!reflow || !host) return;
    const value: EPUBBlockOverlay<PDFBlock> = new EPUBBlockOverlay<PDFBlock>(
      host,
      () => {},
      (id) => {
        if (state.current.theme.blockFocus !== false) void value.focus(id);
      },
      () => state.current.blocks,
      (block, action) => {
        if (action === "copy" && !block.image) {
          const translation = state.current.translations.find(
            (t) => t.blockId === block.id,
          );
          void copyText(reflowBlockText(block.text, translation));
          return;
        }
        state.current.events.blockAction?.(block, action);
      },
    );
    overlay.current = value;
    return () => {
      overlay.current = undefined;
      // Its action buttons are a React root; unmount it outside this commit.
      queueMicrotask(() => value.destroy());
    };
  }, [reflow, doc.id]);
  const visitCitation = async (blockId: string, label: string) => {
    try {
      if (label.startsWith("figure:")) {
        const block = figureTarget(blocks, label.slice(7));
        if (!block) throw new Error(`未找到图 ${label.slice(7)} 的图片位置`);
        if (facade.current) events.internalLink?.(facade.current.getLocation());
        focusBlock(block, "translation");
        return;
      }
      const target =
        (await engine?.resolveCitation?.(blockId, label)) ??
        numberedReference(blocks, label);
      if (!target) throw new Error(`未找到参考论文 [${label}] 的跳转位置`);
      if (facade.current) events.internalLink?.(facade.current.getLocation());
      await go(target);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const ready = (adapter: ReaderAdapter, toc: TOCItem[]) => {
    outline.current = toc;
    setEngine(adapter);
    facade.current = new Proxy(adapter, {
      get(target, key) {
        if (key === "prepareAnnotation")
          return async (value: ReaderSelection) => {
            if (value.location.type !== "pdf") return value;
            // Keep navigation metadata, but never persist a cross-side mark.
            const { sentenceLink: _, ...location } = value.location;
            return { ...value, location };
          };
        if (key === "goTo")
          return (l: DocumentLocation) => actions.current.go(l);
        if (key === "flashReference" && state.current.reflow)
          return (l: DocumentLocation, text: string) =>
            actions.current.flash(l, text);
        if (key === "search")
          return async (query: string) => {
            const current = state.current;
            if (!current.blocks.length) return target.search(query);
            const found = searchPDFBlocks(
              query,
              current.blocks,
              current.translations,
            );
            const parsedPages = new Set(
              current.blocks.map((block) => block.page),
            );
            if (
              parsedPages.size >= (target.getPageCount?.() ?? parsedPages.size)
            )
              return found;
            const unparsed = (await target.search(query)).filter(
              (result) =>
                result.location.type === "pdf" &&
                !parsedPages.has(result.location.page),
            );
            return [...found, ...unparsed].slice(0, 100);
          };
        if (key === "focusLocation")
          return (l: DocumentLocation) => actions.current.focus(l);
        if (key === "next" || key === "previous")
          return () => {
            if (!state.current.blocks.length)
              return state.current.reflow ? Promise.resolve() : target[key]();
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            const current =
              block?.page ??
              (state.current.reflow
                ? 1
                : (target.getLocation() as { page: number }).page);
            return actions.current.go({
              type: "pdf",
              page: Math.max(1, current + (key === "next" ? 1 : -1)),
            });
          };
        if (
          key === "getLocation" &&
          (state.current.mode === "translation" || state.current.reflow)
        )
          return () => {
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            return block
              ? blockLocation(block, reading.current?.fraction)
              : state.current.reflow
                ? { type: "pdf", page: 1 }
                : target.getLocation();
          };
        if (
          key === "isNear" &&
          (state.current.mode === "translation" || state.current.reflow)
        )
          return (location: DocumentLocation) => {
            const block = locationBlock(location),
              host = pane.current;
            const node = block && targetNode(block.id);
            if (!block || !host || !node || location.type !== "pdf")
              return false;
            const rect = node.getBoundingClientRect(),
              view = host.getBoundingClientRect();
            const fraction = Math.max(
              0,
              Math.min(
                1,
                ((location.y ?? block.bounds.y) - block.bounds.y) /
                  (block.bounds.height || 1),
              ),
            );
            return (
              Math.abs(
                rect.top + rect.height * fraction - view.top - view.height / 2,
              ) <
              view.height / 4
            );
          };
        if (key === "clearSelection")
          return () => {
            window.getSelection()?.removeAllRanges();
            selection.current = null;
            void target.focusSentences?.("", []);
            state.current.events.selection(null);
            target.clearSelection();
          };
        if (key === "getSelection")
          return () => selection.current ?? target.getSelection();
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    onReady(facade.current, toc);
  };
  useLayoutEffect(() => {
    if (progressSeeded.current || reading.current) return;
    if (doc.progress?.type !== "pdf") {
      progressSeeded.current = true;
      return;
    }
    const block = locationBlock(doc.progress);
    if (!block) return;
    reading.current = { blockId: block.id, fraction: 0.5 };
    progressSeeded.current = true;
  }, [blocks, doc.id]);
  useLayoutEffect(() => {
    input(
      readingMode === "translation" || readingMode === "reflow"
        ? "translation"
        : "source",
    );
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    pendingRestore.current = true;
    if (reading.current)
      reading.current = { ...reading.current, fraction: 0.5 };
    engine?.cancelBlockFocus?.();
    setPopup(undefined);
    return () => {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = 0;
      cancelTranslationMotion();
      deferredFocus.cancel();
      explicitFocus.current.operation++;
      engine?.cancelBlockFocus?.();
    };
  }, [readingMode, active]);
  // Wait for the saved paragraph before restoring reflow progress.
  const reflowRestored = useRef(false);
  useLayoutEffect(() => {
    reflowRestored.current = false;
  }, [doc.id, reflow]);
  useLayoutEffect(() => {
    if (!engine || !active) return;
    hoverOwner.current = undefined;
    setHoveredBlock(undefined);
    engine.hoverBlock?.(null);
    const previous = previousMode.current;
    previousMode.current = readingMode;
    const layoutChanged =
      (previous === "reflow" ? "translation" : previous) !== paneMode;
    let cancelled = false;
    selection.current = null;
    events.selection(null);
    window.getSelection()?.removeAllRanges();
    void engine.focusSentences?.("", []);
    const anchor = reading.current;
    const operation = explicitFocus.current.operation;
    const restore = async () => {
      if (!pendingRestore.current) return;
      if (reflow) {
        restoreReflow();
        return;
      }
      if (layoutChanged) {
        // Use the same preference path as the 适宽 button, including clearing
        // temporary passage zoom and saving this document's zoom preference.
        events.zoom?.("width");
        await engine.setTheme({ ...state.current.theme, zoom: "width" });
        if (cancelled || operation !== explicitFocus.current.operation) return;
      }
      if (anchor && !blocks.some((block) => block.id === anchor.blockId))
        return;
      if (!anchor && doc.progress?.type === "pdf" && !progressSeeded.current)
        return;
      if (mode !== "translation" && anchor) {
        await engine.followBlock?.(anchor);
      }
      if (
        !cancelled &&
        operation === explicitFocus.current.operation &&
        mode !== "source" &&
        anchor
      )
        followTranslation(anchor);
      if (
        !cancelled &&
        operation === explicitFocus.current.operation &&
        anchor
      ) {
        pendingRestore.current = false;
        const block = blocks.find((block) => block.id === anchor.blockId);
        if (block) pinPage(block.page);
        publishReading(anchor);
      } else if (
        !anchor &&
        !cancelled &&
        operation === explicitFocus.current.operation
      ) {
        pendingRestore.current = false;
      }
    };
    const apply = () =>
      void restore().catch((e) => {
        if (!cancelled) toast.error(e.message);
      });
    let frame = 0;
    if (layoutChanged) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!cancelled && operation === explicitFocus.current.operation)
            apply();
        });
      });
    } else apply();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      engine.hoverBlock?.(null);
    };
  }, [readingMode, engine, active, reflow, blocks]);
  const restoreReflow = () => {
    if (
      !active ||
      !state.current.reflow ||
      reflowRestored.current ||
      !pane.current
    )
      return;
    const anchor = reading.current;
    if (anchor && !targetNode(anchor.blockId)) return;
    if (!anchor && doc.progress?.type === "pdf" && !progressSeeded.current)
      return;
    if (!anchor && !visibleBlocks.length) {
      pane.current.scrollTop = 0;
      return;
    }
    reflowRestored.current = true;
    if (anchor) {
      reading.current = anchor;
      followTranslation(anchor);
      const block = blocks.find((block) => block.id === anchor.blockId);
      if (block) pinPage(block.page);
      pendingRestore.current = false;
      publishReading(anchor);
    } else {
      recordReading({ blockId: visibleBlocks[0].id, fraction: 0 });
      pane.current.scrollTop = 0;
      pendingRestore.current = false;
    }
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useEffect(() => {
    const release = () => {
      selecting.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  const input = (active: typeof side.current) => {
    pendingRestore.current = false;
    reflowRestored.current = true;
    deferredFocus.cancel();
    cancelTranslationMotion();
    if (explicitFocus.current.moving || active === "translation")
      engine?.cancelBlockFocus?.();
    explicitFocus.current.operation++;
    explicitFocus.current.moving = false;
    setFocusedBlock(undefined);
    side.current = active;
    control.current.input(active);
  };
  const sourceSelection = (value: ReaderSelection | null) => {
    if (side.current !== "source") return;
    selection.current = value;
    events.selection(value);
  };
  const translatedSelection = () => {
    selecting.current = false;
    const selected = window.getSelection();
    if (!selected?.rangeCount || !selected.toString().trim() || !pane.current)
      return;
    const range = selected.getRangeAt(0);
    if (reflow) {
      const source = reflowSourceSelection(pane.current, range, blocks);
      const target = captureTranslationSelection(
        pane.current,
        range,
        blocks,
        translations,
      )?.selection;
      const value =
        source && target
          ? {
              ...source,
              parts: [
                {
                  ...source,
                  text: selectedSideText(
                    pane.current,
                    range,
                    "[data-reflow-source]",
                  ),
                },
                {
                  ...target,
                  text: selectedSideText(
                    pane.current,
                    range,
                    "[data-translation-block]",
                  ),
                },
              ],
            }
          : (source ?? target);
      if (value) {
        selection.current = value;
        events.selection(value);
      }
      return;
    }
    const value = captureTranslationSelection(
      pane.current,
      selected.getRangeAt(0),
      blocks,
      translations,
    );
    if (!value) return;
    selection.current = value.selection;
    events.selection(value.selection);
  };
  const captureTranslatedReading = () => {
    if (
      selecting.current ||
      explicitFocus.current.moving ||
      translationMotion.current.moving ||
      !pane.current ||
      (reflow && !!reading.current && !reflowRestored.current) ||
      !control.current.canFollow("translation")
    )
      return;
    const v = pane.current.getBoundingClientRect(),
      y = v.top + v.height * 0.5;
    const nodes = Array.from(
      pane.current.querySelectorAll<HTMLElement>(blockSelector),
    );
    const node = nodes.find((n) => n.getBoundingClientRect().bottom > y);
    if (!node) return;
    const r = node.getBoundingClientRect(),
      anchor = {
        blockId: nodeBlockId(node)!,
        fraction: Math.max(0, Math.min(1, (y - r.top) / (r.height || 1))),
      };
    recordReading(anchor);
    return anchor;
  };
  const translatedScroll = () => {
    const anchor = captureTranslatedReading();
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    if (!anchor) return;
    const operation = explicitFocus.current.operation;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (operation !== explicitFocus.current.operation) return;
      publishReading(anchor);
      if (mode === "parallel" && !reflow && syncEnabledRef.current) {
        control.current.following("source");
        void engine?.followBlock?.(anchor);
      }
    });
  };
  const changeMode = (value: ReadingMode) => {
    input(
      value === "translation" || value === "reflow" ? "translation" : "source",
    );
    cancelAnimationFrame(scrollFrame.current);
    engine?.cancelBlockFocus?.();
    setPopup(undefined);
    onReadingModeChange(value);
  };
  const activePopup = popup && byId.get(popup.block.id);
  const toggleSync = () => {
    const enabled = !syncEnabledRef.current;
    syncEnabledRef.current = enabled;
    setSyncEnabled(enabled);
    // Stop pending follow animations before changing the synchronization policy.
    input(side.current);
    engine?.cancelBlockFocus?.();
    const anchor = reading.current;
    if (!enabled || mode !== "parallel" || !anchor) return;
    if (side.current === "source") {
      void followTranslation(anchor, undefined, { smooth: true });
    } else {
      control.current.following("source");
      void engine?.followBlock?.(anchor).catch((e) => toast.error(e.message));
    }
  };
  const autoCenterButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={syncEnabled ? "default" : "outline"}
            size="icon-sm"
            aria-label={syncEnabled ? "取消同步效果" : "开启同步效果"}
            aria-pressed={syncEnabled}
            disabled={reflow}
            onClick={toggleSync}
          />
        }
      >
        <Crosshair />
      </TooltipTrigger>
      <TooltipContent>
        {syncEnabled ? "取消同步效果" : "开启同步效果"}
      </TooltipContent>
    </Tooltip>
  );
  const book = doc.library === "books";
  const pageCount =
    engine?.getPageCount?.() || Math.max(1, ...blocks.map((b) => b.page));
  const bookChapter = useMemo(
    () =>
      book
        ? chapterRange(
            outline.current,
            chapterPage,
            pageCount,
            headingPages(blocks),
          )
        : undefined,
    // The outline ref is filled when the engine becomes ready.
    [book, chapterPage, pageCount, blocks, engine],
  );
  const chapterRevision = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of translations)
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    return Object.entries(counts).sort().join();
  }, [translations]);
  const {
    status: chapterStatus,
    stale: chapterStale,
    refresh: refreshChapter,
  } = useChapterTranslation(
    doc.id,
    bookChapter,
    `${processing?.updatedAt ?? ""}|${blocks.length}|${chapterRevision}`,
    active && book,
  );
  const toolbar = (
    <div className="translation-toolbar">
      {autoCenterHost === undefined && autoCenterButton}
      {book ? (
        <BookChapterControls
          documentId={doc.id}
          processing={processing}
          status={chapterStatus}
          stale={chapterStale}
          title={bookChapter && chapterTitle(outline.current, bookChapter)}
          onRequest={async (retranslate = false) => {
            if (!bookChapter) return;
            const result = await api.translateRange(
              doc.id,
              bookChapter.fromPage,
              bookChapter.toPage,
              retranslate,
            );
            if (result.parsing) toast("正在解析本章，完成后开始翻译");
          }}
          onChange={refreshChapter}
        />
      ) : (
        <AssistanceControls document={doc} processing={processing} />
      )}
      <Tabs
        value={readingMode}
        onValueChange={(value) => changeMode(value as ReadingMode)}
      >
        <TabsList>
          <TabsTrigger value="source">原文</TabsTrigger>
          <TabsTrigger value="parallel" data-tour="parallel-mode">
            对照
          </TabsTrigger>
          <TabsTrigger value="reflow">重排</TabsTrigger>
          <TabsTrigger value="translation">译文</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
  return (
    <div
      className="pdf-reading"
      style={
        { "--reading-margin": `${theme.readingMargin}px` } as CSSProperties
      }
      data-reading-mode={mode}
      data-reflow={reflow || undefined}
      ref={root}
      data-theme={theme.mode}
      data-dark-contrast={theme.pdfDarkContrast ?? "soft"}
    >
      {autoCenterHost && createPortal(autoCenterButton, autoCenterHost)}
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {(mode === "translation" || reflow) && (
        <div className="pdf-reading-controls">
          <div className="pdf-page-navigation">{pageNavigation}</div>
        </div>
      )}
      <TranslationPanes
        mode={paneMode}
        swapped={swapped}
        onSwap={() => updateReaderLayout({ swapped: !swapped })}
        sourceWidth={sourceWidth}
        onSourceWidthChange={(sourceWidth) =>
          updateReaderLayout({ sourceWidth })
        }
        onResizeStart={() => engine?.cancelBlockFocus?.()}
        source={
          <div
            className="translation-source"
            inert={mode === "translation" || reflow}
            onWheelCapture={() => input("source")}
            onPointerDownCapture={() => input("source")}
            onKeyDownCapture={() => input("source")}
          >
            <ReaderView
              active={active}
              document={doc}
              theme={theme}
              annotations={annotations.filter(
                (a) => a.location.type !== "pdf" || !a.location.translation,
              )}
              blocks={blocks}
              onReady={ready}
              events={{
                ...events,
                selection: sourceSelection,
                blockFocus: (block) => {
                  if (state.current.theme.blockFocus !== false)
                    void focusBlock(block, "source");
                },
                location: (location, percentage) => {
                  if (
                    state.current.mode === "translation" ||
                    state.current.reflow ||
                    side.current !== "source" ||
                    (pendingRestore.current && !!reading.current)
                  )
                    return;
                  if (
                    location.type === "pdf" &&
                    !state.current.blocks.some(
                      (b) =>
                        b.page === location.page &&
                        !isPDFPageDecoration(b) &&
                        (b.image || b.text.trim()),
                    )
                  ) {
                    reading.current = undefined;
                    progressSeeded.current = true;
                    driftPage(location.page);
                    events.location(location, percentage);
                  }
                },
                readingAnchor: (anchor) => {
                  if (
                    state.current.reflow ||
                    state.current.mode === "translation"
                  )
                    return;
                  if (
                    explicitFocus.current.moving ||
                    (pendingRestore.current && !!reading.current) ||
                    !control.current.canFollow("source") ||
                    selecting.current
                  )
                    return;
                  recordReading(anchor);
                  publishReading(anchor);
                  if (
                    state.current.mode === "parallel" &&
                    !state.current.reflow &&
                    syncEnabledRef.current
                  )
                    followTranslation(anchor);
                },
                blockHover: (block) => {
                  if (mode === "parallel") hover("source", block?.id);
                },
                blockAction: (block, action) => {
                  // The page shows extracted text; copying gives the source
                  // with the repairs its translation made.
                  if (action === "copy" && !block.image) {
                    const translation = state.current.translations.find(
                      (t) => t.blockId === block.id,
                    );
                    void copyText(restoredSource(block.text, translation));
                    return;
                  }
                  if (action !== "translate") {
                    events.blockAction?.(block, action);
                    return;
                  }
                  const button = root.current?.querySelector<HTMLElement>(
                    `[data-block-id="${block.id}"] [data-block-action="translate"]`,
                  );
                  setPopup({
                    block,
                    rect:
                      button?.getBoundingClientRect() ??
                      root.current!.getBoundingClientRect(),
                  });
                },
              }}
            />
            {mode !== "translation" && !reflow && (
              <div className="pdf-reading-controls">
                <div className="pdf-page-navigation">{pageNavigation}</div>
              </div>
            )}
          </div>
        }
        translation={
          (reflow || mode !== "source") && (
            <div
              className="translation-document"
              ref={pane}
              tabIndex={0}
              aria-label="论文译文"
              onScroll={() => {
                hover("translation");
                translatedScroll();
              }}
              onPointerLeave={() => hover("translation")}
              onWheelCapture={() => input("translation")}
              onPointerDownCapture={(event) => {
                const section = (event.target as Element).closest<HTMLElement>(
                  blockSelector,
                );
                pressedBlock.current =
                  section && event.button === 0
                    ? {
                        id: nodeBlockId(section)!,
                        x: event.clientX,
                        y: event.clientY,
                      }
                    : undefined;
                input("translation");
                hover("translation");
                // The viewport itself receives scrollbar presses. Keep following
                // those scrolls while the pointer is down; only text drags select.
                selecting.current = !!section && event.button === 0;
                selection.current = null;
                events.selection(null);
                void engine?.focusSentences?.("", []);
              }}
              onPointerUp={translatedSelection}
              onDoubleClick={(event) => {
                // Select the translated sentence; untranslated text falls
                // back to the sentence around the word.
                const target = event.target as Element;
                const sentence = target.closest(
                  ".translation-sentence, .reflow-sentence",
                );
                const selected = window.getSelection();
                if (sentence && selected) {
                  const range = document.createRange();
                  range.selectNodeContents(sentence);
                  selected.removeAllRanges();
                  selected.addRange(range);
                } else {
                  const section = target.closest("section");
                  if (section) selectSentence(selected, section);
                }
                translatedSelection();
              }}
              onKeyDownCapture={() => input("translation")}
              onKeyUp={translatedSelection}
              onClick={(event) => overlay.current?.click(event.nativeEvent)}
              style={{
                ...(reflow && {
                  "--reflow-source-font": sourceFont(theme.fontFamily),
                  "--reflow-source-size": `${theme.fontSize / (theme.translationFontSize ?? 1)}em`,
                  "--reflow-source-weight":
                    theme.fontWeight === "bold" ? 600 : 400,
                }),
                fontSize: `${theme.translationFontSize ?? 1}rem`,
                fontFamily: translationFont(theme.translationFontFamily),
                fontWeight:
                  (theme.translationFontWeight ??
                    defaultTheme.translationFontWeight) === "bold"
                    ? 600
                    : undefined,
                lineHeight: theme.lineHeight,
              }}
            >
              {error && <p role="alert">{error}</p>}
              {!visibleBlocks.length && (
                <p role="status">
                  {doc.library === "books" && !reflow
                    ? "尚未翻译任何章节，可在工具栏翻译本章。"
                    : "正文仍在解析中，完成的段落会在这里显示。"}
                </p>
              )}
              {visibleBlocks.map((block) => {
                const translated = byId.get(block.id),
                  noteIndexes = annotations.flatMap((a) => {
                    const mark =
                      a.location.type === "pdf"
                        ? a.location.translation
                        : undefined;
                    return mark
                      ? (mark.ranges ?? [mark])
                          .filter(
                            (r) =>
                              r.blockId === block.id &&
                              r.sourceHash === translated?.sourceHash,
                          )
                          .flatMap((r) => r.sentenceIndexes)
                      : [];
                  });
                const text = (
                  <TranslationText
                    block={block}
                    onCitation={(blockId, label) =>
                      void visitCitation(blockId, label)
                    }
                    formulaNumber={equationNumbers.byFormula.get(block.id)}
                    translation={translated}
                    documentId={doc.id}
                    renderImage={blockImages?.url}
                    imageTheme={imageKey}
                    retry={() => void translate(block.id)}
                    paused={
                      processing?.enabled === false ||
                      processing?.status === "paused"
                    }
                  />
                );
                const indicator = noteIndexes.length > 0 && (
                  <span
                    className="translation-note-indicator"
                    title="此段有已保存的标注"
                    aria-label="此段有已保存的标注"
                  />
                );
                if (reflow)
                  return (
                    <section
                      key={block.id}
                      data-reflow-block={block.id}
                      data-block-kind={block.image ? "image" : "text"}
                      data-label={block.label}
                      data-search-hit={
                        searchBlockIds.includes(block.id) || undefined
                      }
                      className={
                        noteIndexes.length ? "translation-annotated" : ""
                      }
                    >
                      {showsOriginal(block) ? (
                        <div data-translation-block={block.id}>{text}</div>
                      ) : (
                        <TranslationText
                          {...text.props}
                          source={
                            <ReflowSource
                              block={block}
                              translation={translated}
                              onCitation={text.props.onCitation}
                            />
                          }
                          showTranslation
                          markTranslation
                        />
                      )}
                      {indicator}
                    </section>
                  );
                return (
                  <section
                    key={block.id}
                    data-translation-block={block.id}
                    data-block-kind={block.image ? "image" : "text"}
                    data-label={block.label}
                    data-hovered={hoveredBlock === block.id || undefined}
                    data-focused={focusedBlock === block.id || undefined}
                    data-search-hit={
                      searchBlockIds.includes(block.id) || undefined
                    }
                    aria-current={focusedBlock === block.id || undefined}
                    tabIndex={0}
                    onClick={(event) => {
                      const pressed = pressedBlock.current;
                      pressedBlock.current = undefined;
                      if (
                        (event.target as Element).closest(
                          "a, button, input, textarea, select, [role=button], [contenteditable=true]",
                        ) ||
                        window.getSelection()?.toString().trim() ||
                        (event.detail > 0 &&
                          (!pressed ||
                            pressed.id !== block.id ||
                            Math.hypot(
                              event.clientX - pressed.x,
                              event.clientY - pressed.y,
                            ) > 5))
                      )
                        return;
                      if (theme.blockFocus !== false)
                        deferredFocus.schedule(event.detail, () => {
                          if (!window.getSelection()?.toString().trim())
                            focusTranslation(block);
                        });
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        focusTranslation(block);
                      }
                    }}
                    onPointerEnter={(event) => {
                      if (!event.buttons && !selecting.current)
                        hover("translation", block.id);
                    }}
                    onPointerMove={(event) => {
                      if (!event.buttons && !selecting.current)
                        hover("translation", block.id);
                    }}
                    onPointerLeave={() => hover("translation")}
                    className={
                      noteIndexes.length ? "translation-annotated" : ""
                    }
                  >
                    {text}
                    {indicator}
                  </section>
                );
              })}
            </div>
          )
        }
      />
      <Popover
        open={!!popup}
        onOpenChange={(open) => {
          if (!open) setPopup(undefined);
        }}
      >
        <PopoverContent
          anchor={
            popup ? { getBoundingClientRect: () => popup.rect } : undefined
          }
          className="translation-popover"
          side="bottom"
          align="end"
        >
          {popup && (
            <>
              <TranslationText
                block={popup.block}
                onCitation={(blockId, label) =>
                  void visitCitation(blockId, label)
                }
                formulaNumber={equationNumbers.byFormula.get(popup.block.id)}
                translation={activePopup}
                documentId={doc.id}
                renderImage={blockImages?.url}
                imageTheme={imageKey}
                retry={() => void translate(popup.block.id)}
                paused={
                  processing?.enabled === false ||
                  processing?.status === "paused"
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  recordReading({ blockId: popup.block.id, fraction: 0 });
                  changeMode("parallel");
                }}
              >
                进入双栏对照
              </Button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
