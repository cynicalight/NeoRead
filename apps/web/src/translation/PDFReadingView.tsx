import { figureTarget } from "../readers/figure-references";
import { readerLayout, updateReaderLayout } from "../neoread-layout";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "./useTranslations";
import { createPortal } from "react-dom";
import { Crosshair, Minus, Plus } from "lucide-react";
import { useTranslationZoom } from "./useTranslationZoom";
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
import { TranslationText } from "./TranslationText";
import {
  PDFTranslationBlock,
  type PDFBlockInteractions,
} from "./PDFTranslationBlock";
import { translationBlockAt } from "./translation-viewport";
import { blockImageCache } from "./block-images";
import { useSentenceMarks } from "./useSentenceMarks";
import { translatedSelection as captureTranslationSelection } from "./selection";
import { installTranslationSelectionHighlight } from "./selection-highlight";
import { translationFont } from "../appearance";
import { selectSentence } from "../readers/sentence-selection";
import { installCitationHover } from "../readers/citation-hover";
import { numberedReference } from "../readers/pdf-citations";
import "./translation.css";

import { AssistanceControls } from "./AssistanceControls";
import { chapterRange, headingPages } from "./chapters";
import { searchPDFBlocks } from "./pdf-search";

type Mode = "source" | "parallel" | "translation";
export function PDFReadingView({
  document: doc,
  active = true,
  theme,
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
  annotations: Annotation[];
  blocks: PDFBlock[];
  processing?: Processing;
  toolbarHost?: HTMLElement | null;
  autoCenterHost?: HTMLElement | null;
  pageNavigation?: ReactNode;
  sidebarsOpen?: { left: boolean; right: boolean };
  searchResults?: SearchResult[];
  searchQuery?: string;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  events: ReaderEvents;
}) {
  const { swapped, sourceWidth } = readerLayout(theme.readerLayout);
  const [mode, setMode] = useState<Mode>("source"),
    [syncEnabled, setSyncEnabled] = useState(true);
  const { translations, error } = useTranslations(doc.id, undefined, active);
  const [popup, setPopup] = useState<{ block: PDFBlock; rect: DOMRect }>();
  const [engine, setEngine] = useState<ReaderAdapter>();
  const [hoveredBlock, setHoveredBlock] = useState<string>();
  const [focusedBlock, setFocusedBlock] = useState<string>();
  const hoverBlock = useRef<string | undefined>(undefined);
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const hover = (origin: "source" | "translation", blockId?: string) => {
    if (!blockId && hoverOwner.current !== origin) return;
    if (
      hoverBlock.current === blockId &&
      hoverOwner.current === (blockId ? origin : undefined)
    )
      return;
    hoverBlock.current = blockId;
    hoverOwner.current = blockId ? origin : undefined;
    setHoveredBlock(blockId);
    engine?.hoverBlock?.(
      mode === "parallel" && origin === "translation"
        ? (blockId ?? null)
        : null,
    );
  };
  const previousMode = useRef<Mode>("source");
  const syncEnabledRef = useRef(syncEnabled);
  syncEnabledRef.current = syncEnabled;
  const explicitFocus = useRef({
    operation: 0,
    moving: false,
  });
  const root = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    control = useRef(new ReadingSync()),
    side = useRef<"source" | "translation">("source"),
    reading = useRef<PDFReadingAnchor | undefined>(undefined);
  const translationZoom = useTranslationZoom(pane, active && mode !== "source");
  // Keep only the current follow target. Content coordinates survive scrolling;
  // layout/content changes invalidate them without retaining detached blocks.
  const followGeometry = useRef<
    | {
        node: HTMLElement;
        host: HTMLElement;
        top: number;
        left: number;
        width: number;
        height: number;
        viewportHeight: number;
        viewportWidth: number;
        maxTop: number;
      }
    | undefined
  >(undefined);
  const invalidateFollowGeometry = () => {
    followGeometry.current = undefined;
  };
  const recordReading = (anchor: PDFReadingAnchor) => {
    reading.current = anchor;
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
      invalidateFollowGeometry();
      const node = Array.from(
        host.querySelectorAll<HTMLElement>("[data-translation-block]"),
      ).find(
        (node) => node.dataset.translationBlock === reading.current?.blockId,
      );
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
      invalidateFollowGeometry();
      cancelTranslationMotion();
    };
  }, [mode, doc.id, active]);
  const state = useRef({ mode, blocks, translations, events, theme });
  state.current = { mode, blocks, translations, events, theme };
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
  const blocksById = useMemo(
    () => new Map(blocks.map((block) => [block.id, block])),
    [blocks],
  );
  const selecting = useRef(false),
    selection = useRef<ReaderSelection | null>(null),
    scrollFrame = useRef(0);
  const equationNumbers = useMemo(() => formulaNumbers(blocks), [blocks]);
  const [blockImages, setBlockImages] =
    useState<ReturnType<typeof blockImageCache>>();
  useEffect(() => {
    if (!engine?.renderBlockImage) return;
    const cache = blockImageCache(engine.renderBlockImage.bind(engine));
    setBlockImages(cache);
    return () => {
      cache.dispose();
      setBlockImages(undefined);
    };
  }, [engine, blocks]);
  const visibleBlocks = useMemo(
    () =>
      blocks.filter(
        (b) => !isPDFPageDecoration(b) && !equationNumbers.pairedIds.has(b.id),
      ),
    [blocks, equationNumbers],
  );
  const nodes = useRef<HTMLElement[]>([]);
  const nodesById = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    invalidateFollowGeometry();
    nodes.current = Array.from(
      pane.current?.querySelectorAll<HTMLElement>("[data-translation-block]") ??
        [],
    );
    nodesById.current = new Map(
      nodes.current.map((node) => [node.dataset.translationBlock!, node]),
    );
  }, [visibleBlocks, mode]);
  useLayoutEffect(invalidateFollowGeometry, [
    translations,
    translationZoom.zoom,
    translationZoom.width,
    theme.translationFontSize,
    theme.translationFontFamily,
    theme.translationFontWeight,
    theme.lineHeight,
    sourceWidth,
    swapped,
    active,
  ]);
  useLayoutEffect(() => {
    const host = pane.current,
      body = content.current;
    if (!active || !host || !body) return;
    const resize = new ResizeObserver(invalidateFollowGeometry);
    resize.observe(host);
    resize.observe(body);
    document.fonts?.addEventListener("loadingdone", invalidateFollowGeometry);
    return () => {
      resize.disconnect();
      document.fonts?.removeEventListener(
        "loadingdone",
        invalidateFollowGeometry,
      );
      invalidateFollowGeometry();
    };
  }, [mode, doc.id, active]);
  const sourceAnnotations = useMemo(
    () =>
      annotations.filter(
        (a) => a.location.type !== "pdf" || !a.location.translation,
      ),
    [annotations],
  );
  const annotatedBlocks = useMemo(() => {
    const result = new Set<string>();
    for (const annotation of annotations) {
      const mark =
        annotation.location.type === "pdf"
          ? annotation.location.translation
          : undefined;
      if (!mark) continue;
      for (const part of mark.ranges ?? [mark]) {
        if (
          part.sourceHash === byId.get(part.blockId)?.sourceHash &&
          part.sentenceIndexes.length
        )
          result.add(part.blockId);
      }
    }
    return result;
  }, [annotations, byId]);
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
  const translate = async (blockId = "") => {
    try {
      await api.translate(doc.id, blockId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const targetNode = (id: string) => nodesById.current.get(id);
  const followTranslation = (
    anchor: PDFReadingAnchor,
    sentenceIndex?: number,
    options: { smooth?: boolean; center?: boolean } = {},
  ) => {
    const node = targetNode(anchor.blockId),
      host = pane.current;
    if (!node || !host) return;
    control.current.following("translation");
    if (
      translationMotion.current.moving &&
      translationMotion.current.blockId === anchor.blockId &&
      !options.center
    )
      return;
    const target =
      sentenceIndex === undefined
        ? node
        : (node.querySelector<HTMLElement>(
            `[data-sentence="${sentenceIndex}"]`,
          ) ?? node);
    let geometry = followGeometry.current;
    if (
      geometry?.node !== target ||
      geometry.host !== host ||
      sentenceIndex !== undefined ||
      options.center ||
      options.smooth
    ) {
      const r = target.getBoundingClientRect(),
        v = host.getBoundingClientRect();
      geometry = {
        node: target,
        host,
        top: host.scrollTop + r.top - v.top,
        left: host.scrollLeft + r.left - v.left,
        width: r.width,
        height: r.height,
        viewportHeight: v.height,
        viewportWidth: host.clientWidth,
        maxTop: Math.max(0, host.scrollHeight - host.clientHeight),
      };
      if (sentenceIndex === undefined) followGeometry.current = geometry;
    }
    const top = Math.max(
      0,
      Math.min(
        geometry.maxTop,
        geometry.top -
          (options.center
            ? Math.max(0, (geometry.viewportHeight - geometry.height) / 2)
            : geometry.viewportHeight * 0.5 -
              (sentenceIndex === undefined
                ? geometry.height * anchor.fraction
                : 0)),
      ),
    );
    cancelTranslationMotion();
    if (!options.smooth) {
      if (Math.abs(host.scrollTop - top) > 0.5) host.scrollTop = top;
      return;
    }
    const motion = translationMotion.current;
    const operation = motion.operation;
    motion.moving = true;
    motion.blockId = anchor.blockId;
    return animatePDFScroll(
      host,
      options.center
        ? geometry.left + geometry.width / 2 - geometry.viewportWidth / 2
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
    recordReading(anchor);
    // Both panels center their own geometry; a tall translation must not shift
    // a short original away from its center (or vice versa).
    const source =
      mode !== "translation" ? engine?.focusBlock?.(block.id, mode) : undefined;
    const translated =
      mode !== "source"
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
      { type: "pdf", page: block.page, x: block.bounds.x, y: block.bounds.y },
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
    input(mode === "translation" ? "translation" : "source");
    await engine?.goTo(location);
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
      state.current.events.location(
        location,
        block.page / Math.max(1, ...state.current.blocks.map((b) => b.page)),
      );
    }
  };
  const focus = async (location: DocumentLocation) => {
    const block = locationBlock(location);
    const completed = block
      ? focusBlock(block, mode === "translation" ? "translation" : "source")
      : go(location);
    const operation = explicitFocus.current.operation;
    await completed;
    if (operation !== explicitFocus.current.operation) return;
    if (location.type === "pdf" && mode !== "translation")
      engine?.flashReference?.(location, location.quote ?? "");
  };
  // Keep the public adapter usable by TOC, notes and page navigation in all modes.
  const facade = useRef<ReaderAdapter | undefined>(undefined);
  const outline = useRef<TOCItem[]>([]);
  const actions = useRef({ go, focus });
  actions.current = { go, focus };
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
            if (!state.current.blocks.length) return target[key]();
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            const current =
              block?.page ?? (target.getLocation() as { page: number }).page;
            return actions.current.go({
              type: "pdf",
              page: Math.max(1, current + (key === "next" ? 1 : -1)),
            });
          };
        if (key === "getLocation" && state.current.mode === "translation")
          return () => {
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            return block
              ? {
                  type: "pdf",
                  page: block.page,
                  x: block.bounds.x,
                  y:
                    block.bounds.y +
                    (reading.current?.fraction ?? 0) * block.bounds.height,
                }
              : target.getLocation();
          };
        if (key === "isNear" && state.current.mode === "translation")
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
  useEffect(() => {
    if (!engine || !active) return;
    hoverOwner.current = undefined;
    hoverBlock.current = undefined;
    setHoveredBlock(undefined);
    engine.hoverBlock?.(null);
    const previous = previousMode.current;
    previousMode.current = mode;
    let cancelled = false;
    selection.current = null;
    events.selection(null);
    window.getSelection()?.removeAllRanges();
    void engine.focusSentences?.("", []);
    const anchor = reading.current;
    const operation = explicitFocus.current.operation;
    const restore = async () => {
      if (previous !== mode) {
        // Use the same preference path as the 适宽 button, including clearing
        // temporary passage zoom and saving this document's zoom preference.
        events.zoom?.("width");
        await engine.setTheme({ ...state.current.theme, zoom: "width" });
        if (cancelled) return;
        if (mode !== "translation" && anchor && syncEnabledRef.current)
          await engine.followBlock?.(anchor);
      }
      if (!cancelled && mode !== "source" && anchor) followTranslation(anchor);
    };
    const apply = () =>
      void restore().catch((e) => {
        if (!cancelled) toast.error(e.message);
      });
    // Both PDF fit-width and translation positioning need the expanded panes.
    let frame = 0;
    if (previous !== mode) {
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
  }, [mode, engine, active]);
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
    cancelTranslationMotion();
    if (
      mode !== "translation" &&
      (explicitFocus.current.moving || active === "translation")
    )
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
  const translatedScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (
        selecting.current ||
        explicitFocus.current.moving ||
        translationMotion.current.moving ||
        !pane.current ||
        !control.current.canFollow("translation")
      )
        return;
      const v = pane.current.getBoundingClientRect(),
        y = v.top + v.height * 0.5;
      const node = translationBlockAt(nodes.current, y);
      if (!node) return;
      const r = node.getBoundingClientRect(),
        anchor = {
          blockId: node.dataset.translationBlock!,
          fraction: Math.max(0, Math.min(1, (y - r.top) / (r.height || 1))),
        };
      recordReading(anchor);
      const block = blocksById.get(anchor.blockId);
      if (block)
        events.location(
          {
            type: "pdf",
            page: block.page,
            x: block.bounds.x,
            y: block.bounds.y + anchor.fraction * block.bounds.height,
          },
          block.page /
            (engine?.getPageCount?.() ||
              Math.max(1, ...blocks.map((b) => b.page))),
        );
      if (mode === "parallel" && syncEnabledRef.current) {
        control.current.following("source");
        void engine?.followBlock?.(anchor);
      }
    });
  };
  const changeMode = (value: Mode) => {
    input(value === "translation" ? "translation" : "source");
    setPopup(undefined);
    setMode(value);
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
  const blockInteractions = useRef<PDFBlockInteractions>(null!);
  blockInteractions.current = {
    pressed: pressedBlock,
    selecting,
    focus: focusTranslation,
    hover: (id) => hover("translation", id),
    preview: (block) => {
      input("translation");
      events.blockAction?.(block, "preview");
    },
    cite: (id, label) => void visitCitation(id, label),
    translate: (id) => void translate(id),
  };
  const translatedBlocks = useMemo(
    () =>
      visibleBlocks.map((block) => (
        <PDFTranslationBlock
          key={block.id}
          block={block}
          translation={byId.get(block.id)}
          documentId={doc.id}
          number={equationNumbers.byFormula.get(block.id)}
          annotated={annotatedBlocks.has(block.id)}
          hovered={hoveredBlock === block.id}
          focused={focusedBlock === block.id}
          searchHit={searchBlockIds.includes(block.id)}
          renderImage={blockImages?.url}
          releaseImage={blockImages?.release}
          imageScale={block.image ? translationZoom.zoom : 1}
          paused={processing?.enabled === false}
          interactions={blockInteractions}
        />
      )),
    [
      visibleBlocks,
      byId,
      doc.id,
      equationNumbers,
      annotatedBlocks,
      hoveredBlock,
      focusedBlock,
      searchBlockIds,
      blockImages,
      translationZoom.zoom,
      processing?.enabled,
    ],
  );
  const toolbar = (
    <div className="translation-toolbar">
      {!autoCenterHost && autoCenterButton}
      <AssistanceControls
        documentId={doc.id}
        processing={processing}
        library={doc.library}
        chapter={() => {
          const location = facade.current?.getLocation();
          if (location?.type !== "pdf") return undefined;
          return chapterRange(
            outline.current,
            location.page,
            engine?.getPageCount?.() ||
              Math.max(1, ...blocks.map((b) => b.page)),
            headingPages(blocks),
          );
        }}
      />
      <Tabs value={mode} onValueChange={(v) => changeMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="source">仅原文</TabsTrigger>
          <TabsTrigger value="parallel" data-tour="parallel-mode">
            原文译文
          </TabsTrigger>
          <TabsTrigger value="translation">仅译文</TabsTrigger>
        </TabsList>
      </Tabs>
      {mode !== "source" && (
        <div
          className="translation-zoom-controls"
          role="group"
          aria-label="译文缩放"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="缩小译文"
            disabled={translationZoom.zoom <= 1}
            onClick={() => translationZoom.change(translationZoom.zoom - 0.25)}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="重置译文缩放"
            title="重置译文缩放"
            onClick={() => translationZoom.change(1)}
          >
            {Math.round(translationZoom.zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="放大译文"
            disabled={translationZoom.zoom >= 5}
            onClick={() => translationZoom.change(translationZoom.zoom + 0.25)}
          >
            <Plus />
          </Button>
        </div>
      )}
    </div>
  );
  return (
    <div
      className="pdf-reading"
      data-reading-mode={mode}
      ref={root}
      data-theme={theme.mode}
      data-dark-contrast={theme.pdfDarkContrast ?? "soft"}
    >
      {autoCenterHost && createPortal(autoCenterButton, autoCenterHost)}
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {mode === "translation" && (
        <div className="pdf-reading-controls">
          <div className="pdf-page-navigation">{pageNavigation}</div>
        </div>
      )}
      <TranslationPanes
        mode={mode}
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
            inert={mode === "translation"}
            onWheelCapture={() => input("source")}
            onPointerDownCapture={() => input("source")}
            onKeyDownCapture={() => input("source")}
          >
            <ReaderView
              active={active}
              visible={active && mode !== "translation"}
              document={doc}
              theme={theme}
              annotations={sourceAnnotations}
              blocks={blocks}
              onReady={ready}
              events={{
                ...events,
                selection: sourceSelection,
                blockFocus: (block) => {
                  if (block.image && state.current.mode === "parallel") {
                    input("source");
                    events.blockAction?.(block, "preview");
                    return;
                  }
                  void focusBlock(block, "source");
                },
                location: (location, percentage) => {
                  if (
                    state.current.mode !== "translation" &&
                    side.current === "source"
                  )
                    events.location(location, percentage);
                },
                readingAnchor: (anchor) => {
                  if (
                    explicitFocus.current.moving ||
                    !control.current.canFollow("source") ||
                    selecting.current
                  )
                    return;
                  recordReading(anchor);
                  if (
                    state.current.mode === "parallel" &&
                    syncEnabledRef.current
                  )
                    followTranslation(anchor);
                },
                blockHover: (block) => {
                  if (mode === "parallel") hover("source", block?.id);
                },
                blockAction: (block, action) => {
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
            {mode !== "translation" && (
              <div className="pdf-reading-controls">
                <div className="pdf-page-navigation">{pageNavigation}</div>
              </div>
            )}
          </div>
        }
        translation={
          mode !== "source" && (
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
                  "[data-translation-block]",
                );
                pressedBlock.current =
                  section && event.button === 0
                    ? {
                        id: section.dataset.translationBlock!,
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
                const sentence = target.closest(".translation-sentence");
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
              style={{
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
              <div
                className="translation-content translation-zoom-content"
                ref={content}
                style={{
                  zoom: translationZoom.zoom,
                  width: translationZoom.width ?? "100%",
                }}
              >
                {error && <p role="alert">{error}</p>}
                {!visibleBlocks.length && (
                  <p role="status">
                    {doc.library === "books"
                      ? "尚未翻译任何章节，可在工具栏翻译本章。"
                      : "正文仍在解析中，完成的段落会在这里显示。"}
                  </p>
                )}
                {translatedBlocks}
              </div>
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
                releaseImage={blockImages?.release}
                onPreview={() => events.blockAction?.(popup.block, "preview")}
                retry={() => void translate(popup.block.id)}
                paused={processing?.enabled === false}
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
