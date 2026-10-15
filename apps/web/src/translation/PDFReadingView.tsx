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
} from "@reader/core";
import {
  defaultTheme,
  isPDFPageDecoration,
  sentenceAnchor,
} from "@reader/core";
import { api } from "@reader/api";
import { Button } from "@reader/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@reader/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@reader/ui/components/tooltip";
import { Popover, PopoverContent } from "@reader/ui/components/popover";
import { toast } from "sonner";
import { ReaderView } from "../ReaderView";
import { overlap, ReadingSync } from "../readers/pdf-reading";
import { animatePDFScroll } from "../readers/pdf-scroll";
import { TranslationPanes } from "./TranslationPanes";
import { formulaNumbers } from "./formulaNumbers";
import { TranslationText } from "./TranslationText";
import { blockImageCache } from "./block-images";
import { useSentenceMarks } from "./useSentenceMarks";
import { linkTranslatedSelection, sentenceLink } from "./sentence-links";
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
  theme: ReaderTheme;
  annotations: Annotation[];
  blocks: PDFBlock[];
  processing?: Processing;
  toolbarHost?: HTMLElement | null;
  autoCenterHost?: HTMLElement | null;
  pageNavigation?: ReactNode;
  searchResults?: SearchResult[];
  searchQuery?: string;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  events: ReaderEvents;
}) {
  const [mode, setMode] = useState<Mode>("source"),
    [swapped, setSwapped] = useState(false),
    [syncEnabled, setSyncEnabled] = useState(true);
  const { translations, error } = useTranslations(doc.id);
  const [popup, setPopup] = useState<{ block: PDFBlock; rect: DOMRect }>(),
    [linked, setLinked] = useState<Record<string, number[]>>();
  const [engine, setEngine] = useState<ReaderAdapter>();
  const [hoveredBlock, setHoveredBlock] = useState<string>();
  const [focusedBlock, setFocusedBlock] = useState<string>();
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const hover = (origin: "source" | "translation", blockId?: string) => {
    if (!blockId && hoverOwner.current !== origin) return;
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
  const enteringParallel = useRef<string | undefined>(undefined);
  const explicitFocus = useRef({
    operation: 0,
    moving: false,
  });
  const root = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLDivElement>(null),
    control = useRef(new ReadingSync()),
    side = useRef<"source" | "translation">("source"),
    reading = useRef<PDFReadingAnchor | undefined>(undefined);
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
    const host = pane.current;
    if (!host) return;
    let initialized = false;
    const resize = () => {
      const node = Array.from(
        host.querySelectorAll<HTMLElement>("[data-translation-block]"),
      ).find(
        (node) => node.dataset.translationBlock === reading.current?.blockId,
      );
      const before = node?.getBoundingClientRect().top;
      host.style.setProperty(
        "--translation-inset",
        `${host.clientHeight / 2}px`,
      );
      if (initialized && node && before !== undefined)
        host.scrollTop += node.getBoundingClientRect().top - before;
      initialized = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelTranslationMotion();
    };
  }, [mode, doc.id]);
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
  }, [engine]);
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
  useEffect(() => {
    if (theme.linkTranslationAnnotations === false) {
      setLinked(undefined);
      void engine?.focusSentences?.("", []);
    }
  }, [theme.linkTranslationAnnotations, engine]);
  const translate = async (blockId = "") => {
    try {
      await api.translate(doc.id, blockId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const targetNode = (id: string) =>
    Array.from(
      pane.current?.querySelectorAll<HTMLElement>("[data-translation-block]") ??
        [],
    ).find((n) => n.dataset.translationBlock === id);
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
    recordReading(anchor);
    // Both panels center their own geometry; a tall translation must not shift
    // a short original away from its center (or vice versa).
    const source =
      mode !== "translation" ? engine?.focusBlock?.(block.id, mode) : undefined;
    const translated =
      mode !== "source"
        ? followTranslation(anchor, undefined, { smooth: true, center: true })
        : undefined;
    void Promise.all([source, translated])
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
  };
  const focusTranslation = (block: PDFBlock) =>
    focusBlock(block, "translation");
  const locationBlock = (location: DocumentLocation) => {
    if (location.type !== "pdf") return;
    const readable = state.current.blocks.filter(
      (b) => !isPDFPageDecoration(b),
    );
    const linked =
      location.translation?.blockId ?? location.sentenceLink?.parts[0]?.blockId;
    const page = readable.filter((b) => b.page === location.page);
    // Saved selections carry rects rather than x/y; the first marked line
    // decides the paragraph, never the page origin.
    const rect = location.rects?.[0];
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
    if (!block) return go(location);
    focusBlock(block, mode === "translation" ? "translation" : "source");
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
      async (blockId, label) =>
        (await engine.resolveCitation?.(blockId, label)) ??
        numberedReference(blocks, label),
      async (location, anchor) => {
        await engine.previewCitation?.(location, anchor);
      },
      () => engine.hideCitationPreview?.(),
    );
  }, [engine, blocks, mode]);
  const visitCitation = async (blockId: string, label: string) => {
    try {
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
            if (state.current.theme.linkTranslationAnnotations === false) {
              const { sentenceLink: _, ...location } = value.location;
              return { ...value, location };
            }
            if (value.location.sentenceLink) return value;
            if (value.location.translation)
              return linkTranslatedSelection(value, state.current.translations);
            const currentTranslations = state.current.translations;
            const links =
              (await target.matchSentences?.(
                value.location,
                currentTranslations,
              )) ?? [];
            return {
              ...value,
              location: {
                ...value.location,
                sentenceLink: sentenceLink(
                  links,
                  currentTranslations,
                  "source",
                ),
              },
            };
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
            setLinked(undefined);
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
    if (!engine) return;
    hoverOwner.current = undefined;
    setHoveredBlock(undefined);
    engine.hoverBlock?.(null);
    const previous = previousMode.current;
    previousMode.current = mode;
    let cancelled = false;
    selection.current = null;
    events.selection(null);
    window.getSelection()?.removeAllRanges();
    setLinked(undefined);
    void engine.focusSentences?.("", []);
    if (previous !== mode && mode === "parallel") {
      const block = blocks.find(
        (b) => b.id === (enteringParallel.current ?? reading.current?.blockId),
      );
      enteringParallel.current = undefined;
      if (block) {
        // Panel resize commits and ResizeObserver callbacks can follow this effect.
        // Keep the selected block fixed until both panes have their new geometry.
        const motion = explicitFocus.current;
        const operation = motion.operation;
        motion.moving = true;
        let frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (cancelled || operation !== motion.operation) return;
            focusBlock(
              block,
              previous === "translation" ? "translation" : "source",
            );
          });
        });
        return () => {
          cancelled = true;
          cancelAnimationFrame(frame);
          if (operation === motion.operation) motion.moving = false;
          engine.hoverBlock?.(null);
        };
      }
    }
    const restore = async () => {
      if (
        previous !== mode &&
        mode !== "translation" &&
        reading.current &&
        syncEnabledRef.current
      )
        await engine.followBlock?.(reading.current);
      if (cancelled) return;
      if (!cancelled && mode !== "source" && reading.current)
        followTranslation(reading.current);
    };
    void restore().catch((e) => {
      if (!cancelled) toast.error(e.message);
    });
    return () => {
      cancelled = true;
      engine.hoverBlock?.(null);
    };
  }, [mode, engine]);
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
    if (
      !value ||
      value.location.type !== "pdf" ||
      theme.linkTranslationAnnotations === false
    ) {
      setLinked(undefined);
      return;
    }
    const location = value.location;
    const fallback = blocks
      .filter(
        (b) =>
          b.page === location.page &&
          location.rects?.some((r) => overlap(r, b.bounds) > 0),
      )
      .flatMap((block) => {
        const t = byId.get(block.id);
        if (!t) return [];
        const needle = value.text.replace(/\s/g, "").toLowerCase();
        const matches = t.sentences.flatMap((s, i) =>
          sentenceAnchor(s).replace(/\s/g, "").toLowerCase().includes(needle)
            ? [i]
            : [],
        );
        return [
          {
            blockId: block.id,
            sentenceIndexes: matches.length === 1 ? matches : [],
          },
        ];
      });
    const map = async () => {
      const links = (
        (await engine?.matchSentences?.(location, translations)) ?? fallback
      ).filter((l) => l.sentenceIndexes.length);
      if (selection.current !== value || !links.length) return;
      const enriched = {
        ...value,
        location: {
          ...location,
          sentenceLink: sentenceLink(links, translations, "source"),
        },
      };
      selection.current = enriched;
      events.selection(enriched);
      setLinked(
        Object.fromEntries(links.map((l) => [l.blockId, l.sentenceIndexes])),
      );
      const anchor = { blockId: links[0].blockId, fraction: 0 };
      recordReading(anchor);
      if (state.current.mode === "parallel")
        followTranslation(anchor, links[0].sentenceIndexes[0]);
    };
    void map().catch((e) => toast.error(e.message));
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
    const captured =
      theme.linkTranslationAnnotations === false
        ? value.selection
        : linkTranslatedSelection(value.selection, translations);
    selection.current = captured;
    events.selection(captured);
    if (theme.linkTranslationAnnotations === false) return;
    setLinked(
      Object.fromEntries(
        value.links.map((l) => [l.blockId, l.sentenceIndexes]),
      ),
    );
    recordReading({ blockId: value.links[0].blockId, fraction: 0 });
    if (mode === "parallel") {
      control.current.following("source");
      const first = value.passages[0];
      void (
        engine?.focusPassages
          ? engine.focusPassages(value.passages, true)
          : engine?.focusSentences?.(first.blockId, first.sources, true)
      )?.catch((e) => toast.error(e.message));
    }
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
      const nodes = Array.from(
        pane.current.querySelectorAll<HTMLElement>("[data-translation-block]"),
      );
      const node = nodes.find((n) => n.getBoundingClientRect().bottom > y);
      if (!node) return;
      const r = node.getBoundingClientRect(),
        anchor = {
          blockId: node.dataset.translationBlock!,
          fraction: Math.max(0, Math.min(1, (y - r.top) / (r.height || 1))),
        };
      recordReading(anchor);
      const block = blocks.find((b) => b.id === anchor.blockId);
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
    if (value === "parallel" && mode !== "parallel") {
      // Pick from the current viewport before the panels change width.
      const host =
        mode === "translation"
          ? pane.current
          : root.current?.querySelector<HTMLElement>(".pdf-container");
      let nearest: string | undefined;
      let distance = Infinity;
      if (host) {
        const view = host.getBoundingClientRect();
        const x = view.left + view.width / 2,
          y = view.top + view.height / 2;
        for (const block of visibleBlocks) {
          let rect: DOMRect | undefined;
          if (mode === "translation")
            rect = targetNode(block.id)?.getBoundingClientRect();
          else {
            const page = host
              .querySelector<HTMLElement>(
                `.page[data-page-number="${block.page}"]`,
              )
              ?.getBoundingClientRect();
            if (page)
              rect = new DOMRect(
                page.left + block.bounds.x * page.width,
                page.top + block.bounds.y * page.height,
                block.bounds.width * page.width,
                block.bounds.height * page.height,
              );
          }
          if (
            !rect?.height ||
            !rect.width ||
            rect.bottom <= view.top ||
            rect.top >= view.bottom ||
            rect.right <= view.left ||
            rect.left >= view.right
          )
            continue;
          const d =
            Math.max(rect.left - x, x - rect.right, 0) * 2 +
            Math.max(rect.top - y, y - rect.bottom, 0);
          if (d < distance) {
            distance = d;
            nearest = block.id;
          }
        }
      }
      enteringParallel.current = nearest ?? reading.current?.blockId;
    }
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
          <TabsTrigger value="parallel">原文译文</TabsTrigger>
          <TabsTrigger value="translation">仅译文</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
  return (
    <div
      className="pdf-reading"
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
        onSwap={() => setSwapped((value) => !value)}
        source={
          <div
            className="translation-source"
            inert={mode === "translation"}
            onWheelCapture={() => input("source")}
            onPointerDownCapture={() => input("source")}
            onKeyDownCapture={() => input("source")}
          >
            <ReaderView
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
                blockFocus: (block) => focusBlock(block, "source"),
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
                selecting.current = true;
                selection.current = null;
                events.selection(null);
                setLinked(undefined);
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
              {error && <p role="alert">{error}</p>}
              {!visibleBlocks.length && (
                <p role="status">
                  {doc.library === "books"
                    ? "尚未翻译任何章节，可在工具栏翻译本章。"
                    : "正文仍在解析中，完成的段落会在这里显示。"}
                </p>
              )}
              {processing?.incomplete && (
                <p className="translation-warning">
                  部分页面没有可提取文字，需要 OCR；当前译文不完整。
                </p>
              )}
              {visibleBlocks.map((block) => {
                const translated = byId.get(block.id),
                  noteIndexes = annotations.flatMap((a) => {
                    const mark =
                      a.location.type === "pdf"
                        ? a.location.translation
                        : undefined;
                    const pair =
                      a.location.type === "pdf" &&
                      theme.linkTranslationAnnotations !== false
                        ? a.location.sentenceLink
                        : undefined;
                    if (pair?.origin === "source")
                      return pair.parts
                        .filter(
                          (p) =>
                            p.blockId === block.id &&
                            p.sourceHash === translated?.sourceHash,
                        )
                        .map((p) => p.sentenceIndex);
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
                      focusTranslation(block);
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
                    <TranslationText
                      block={block}
                      onCitation={(blockId, label) =>
                        void visitCitation(blockId, label)
                      }
                      formulaNumber={equationNumbers.byFormula.get(block.id)}
                      translation={translated}
                      documentId={doc.id}
                      renderImage={blockImages?.url}
                      retry={() => void translate(block.id)}
                      paused={processing?.enabled === false}
                      linked={linked?.[block.id] ?? []}
                    />
                    {noteIndexes.length > 0 && (
                      <span
                        className="translation-note-indicator"
                        title="此段有已保存的标注"
                        aria-label="此段有已保存的标注"
                      />
                    )}
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
