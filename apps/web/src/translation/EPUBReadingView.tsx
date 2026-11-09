import { reflowBlockText } from "./reflow";
import { copyText } from "../chat/clipboard";
import { useSentenceMarks } from "./useSentenceMarks";
import { useTranslations } from "./useTranslations";
import { readerLayout, updateReaderLayout } from "../neoread-layout";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  DocumentLocation,
  EPUBLocation,
  EPUBReadingBlock,
  ReaderAdapter,
  ReadingAnchor,
  ReaderSelection,
  Processing,
} from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import { Button } from "@neoread/ui/components/button";
import { toast } from "sonner";
import { ReaderView } from "../ReaderView";
import { BookChapterControls } from "./BookChapterControls";
import { useChapterTranslation } from "./chapterTranslation";
import { TranslationPanes } from "./TranslationPanes";
import { TranslationText } from "./TranslationText";
import { translatedSelection } from "./selection";
import { translatedAnnotationRanges } from "./annotations";
import { installTranslationSelectionHighlight } from "./selection-highlight";
import { epubBlocksAt } from "./epub-links";
import { ReadingSync } from "../readers/pdf-reading";
import { animatePDFScroll } from "../readers/pdf-scroll";
import { isSelectionToolbar } from "../readers/selection-anchor";
import { DeferredBlockFocus } from "../readers/deferred-block-focus";
import { defaultTheme } from "@neoread/core";
import { translationFont } from "../appearance";
import "./translation.css";

type Mode = "source" | "parallel" | "translation";
/** Scroll settling after a pinned jump or click does not move the anchor. */
const pinHold = 800;
/** Only what locates the chapter; offsets would refetch on every scroll. */
const blockAnchor = (block: EPUBReadingBlock): EPUBLocation => ({
  type: "epub",
  href: block.location.href,
  blockId: block.id,
});
function chapterAnchor(location: EPUBLocation): EPUBLocation {
  return location.blockId
    ? { type: "epub", href: location.href, blockId: location.blockId }
    : { type: "epub", href: location.href, locator: location.locator };
}
export function EPUBReadingView({
  document: doc,
  active = true,
  theme,
  annotations,
  events,
  onReady,
  toolbarHost,
  processing,
}: ComponentProps<typeof ReaderView> & {
  toolbarHost?: HTMLElement | null;
  autoCenterHost?: HTMLElement | null;
  processing?: Processing;
  pageNavigation?: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>("source");
  // Reflowed text puts each translation under its source paragraph inside the
  // EPUB reader, so one column serves all three modes.
  const reflow = theme.textReflow === true;
  const [companions, setCompanions] = useState<Map<string, HTMLElement>>(
    () => new Map(),
  );
  const companionNodes = useRef(new Map<string, HTMLElement>());
  const { swapped, sourceWidth } = readerLayout(theme.readerLayout);
  const [blocks, setBlocks] = useState<EPUBReadingBlock[]>([]);
  const [chapter, setChapter] = useState(
    doc.progress?.type === "epub" ? doc.progress.href.split("#")[0] : "",
  );
  const { translations, error: streamError } = useTranslations(
    doc.id,
    [...new Set(blocks.map((b) => b.location.href))],
    active,
  );
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [sentenceEngine, setSentenceEngine] = useState<ReaderAdapter>();
  const viewportAnchor = useRef<{ id: string; top: number } | undefined>(
    undefined,
  );
  const engine = useRef<ReaderAdapter | undefined>(undefined);
  const selection = useRef<ReaderSelection | null>(null);
  const deferredFocus = useMemo(() => new DeferredBlockFocus(), []);
  useEffect(() => {
    const cancel = () => deferredFocus.cancel();
    document.addEventListener("pointerdown", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      deferredFocus.cancel();
    };
  }, [deferredFocus]);
  const position = useRef<EPUBLocation>(
    doc.progress?.type === "epub" ? doc.progress : { type: "epub", href: "" },
  );
  const side = useRef<"source" | "translation">("source");
  // The paragraph whose chapter the toolbar describes. A click, selection,
  // jump or paragraph request pins it; afterwards scrolling moves it to the
  // paragraph at the middle of the view.
  const [anchor, setAnchor] = useState<EPUBLocation | undefined>(() =>
    doc.progress?.type === "epub" ? chapterAnchor(doc.progress) : undefined,
  );
  const pinnedAt = useRef(0);
  const driftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const placeAnchor = (location: EPUBLocation) => {
    const next = chapterAnchor(location);
    setAnchor((current) =>
      current?.href === next.href &&
      current.blockId === next.blockId &&
      current.locator === next.locator
        ? current
        : next,
    );
  };
  const pinAnchor = (location: EPUBLocation) => {
    if (!location.href) return;
    pinnedAt.current = performance.now();
    clearTimeout(driftTimer.current);
    placeAnchor(location);
  };
  const driftAnchor = (location: EPUBLocation) => {
    if (
      !location.href ||
      focusMotion.current.moving ||
      performance.now() - pinnedAt.current < pinHold
    )
      return;
    clearTimeout(driftTimer.current);
    driftTimer.current = setTimeout(() => placeAnchor(location), 200);
  };
  useEffect(() => () => clearTimeout(driftTimer.current), []);
  const navigating = useRef(false);
  const syncTarget = useRef<EPUBLocation | undefined>(undefined);
  const pendingFollow = useRef<ReadingAnchor | undefined>(undefined);
  const sync = useRef(new ReadingSync());
  const translationMotion = useRef(0);
  const scrollFrame = useRef(0);
  const modeFrame = useRef(0);
  const dragging = useRef(false);
  const [hoveredBlock, setHoveredBlock] = useState<string>();
  const [focusedBlock, setFocusedBlock] = useState<string>();
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const pressedBlock = useRef<{ id: string; x: number; y: number }>(undefined);
  // An explicit block focus owns both panes until its motion settles.
  const focusMotion = useRef({ operation: 0, moving: false });
  const translationRevision = useMemo(() => {
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
    anchor && { location: anchor },
    `${processing?.updatedAt ?? ""}|${translationRevision}`,
    active,
  );
  const live = useRef({
    mode,
    blocks,
    translations,
    events,
    annotations,
    chapter,
    reflow,
  });
  live.current = {
    mode,
    blocks,
    translations,
    events,
    annotations,
    chapter,
    reflow,
  };
  useSentenceMarks(
    root,
    sentenceEngine,
    blocks,
    translations,
    annotations,
    theme.linkTranslationAnnotations !== false,
    mode,
    events,
  );
  const visible = blocks;
  // Each translated paragraph gets a node inside (or, for runs of a mixed
  // container, right after) its source block. Chapter reloads replace the
  // source DOM, so disconnected nodes are recreated on the next block change.
  useLayoutEffect(() => {
    const container = reflowHost();
    const nodes = companionNodes.current;
    const wanted =
      reflow && mode !== "source" && container
        ? blocks.filter((b) => !b.image && b.text.trim())
        : [];
    const keep = new Set<string>();
    for (const block of wanted) {
      let node = nodes.get(block.id);
      if (!node?.isConnected) {
        const id = JSON.stringify(block.id);
        const anchor = container!.querySelector<HTMLElement>(
          `[data-epub-block=${id}]`,
        );
        if (!anchor) continue;
        node = document.createElement("div");
        node.className = "epub-reflow-translation";
        node.dataset.translationBlock = block.id;
        node.dataset.reflowBlock = block.id;
        if (anchor.matches("[data-epub-run]"))
          Array.from(container!.querySelectorAll(`[data-epub-run=${id}]`))
            .at(-1)!
            .after(node);
        else anchor.append(node);
        nodes.set(block.id, node);
      }
      keep.add(block.id);
    }
    for (const [id, node] of nodes)
      if (!keep.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    setCompanions((current) =>
      current.size === nodes.size &&
      [...nodes].every(([id, node]) => current.get(id) === node)
        ? current
        : new Map(nodes),
    );
  }, [blocks, mode, reflow]);
  useEffect(() => {
    side.current = mode === "translation" && !reflow ? "translation" : "source";
  }, [reflow]);
  const targetNode = (id: string) =>
    Array.from(
      pane.current?.querySelectorAll<HTMLElement>("[data-translation-block]") ??
        [],
    ).find((n) => n.dataset.translationBlock === id);
  /** Scroll following sets the pane directly, as PDF does; jumps animate. */
  const follow = (id: string, fraction = 0.5, instant = false) => {
    if (live.current.reflow) return;
    const block = live.current.blocks.find((b) => b.id === id);
    if (!block) return;
    pendingFollow.current = { blockId: id, fraction };
    if (block.location.href !== live.current.chapter)
      setChapter(block.location.href);
    else {
      const node = targetNode(id),
        host = pane.current;
      if (node && host) {
        pendingFollow.current = undefined;
        const operation = ++translationMotion.current;
        const rect = node.getBoundingClientRect();
        const top =
          host.scrollTop +
          rect.top -
          host.getBoundingClientRect().top +
          rect.height * fraction -
          host.clientHeight / 2;
        sync.current.following("translation");
        if (instant) {
          host.scrollTop = top;
          return;
        }
        void animatePDFScroll(
          host,
          host.scrollLeft,
          top,
          () =>
            operation !== translationMotion.current || pane.current !== host,
          () => {},
        ).finally(() => {
          if (operation === translationMotion.current)
            sync.current.following("translation");
        });
      }
    }
  };
  const hover = (origin: "source" | "translation", blockId?: string) => {
    if (!blockId && hoverOwner.current !== origin) return;
    hoverOwner.current = blockId ? origin : undefined;
    setHoveredBlock(blockId);
    engine.current?.hoverBlock?.(
      live.current.mode === "parallel" && origin === "translation"
        ? (blockId ?? null)
        : null,
    );
  };
  const centerTranslation = (id: string, cancelled: () => boolean) => {
    const node = targetNode(id),
      host = pane.current;
    if (!node || !host) return;
    const r = node.getBoundingClientRect(),
      v = host.getBoundingClientRect();
    return animatePDFScroll(
      host,
      host.scrollLeft,
      host.scrollTop + r.top - v.top - Math.max(0, (v.height - r.height) / 2),
      () => cancelled() || pane.current !== host,
      () => {},
    );
  };
  // Clicking a paragraph on either side centers it in every visible pane, as
  // PDF blocks do; the box fades once both panes arrive.
  const focusBlock = (id: string, origin: "source" | "translation") => {
    const block = live.current.blocks.find((b) => b.id === id);
    if (!block) return;
    input(origin);
    const motion = focusMotion.current;
    const operation = ++motion.operation;
    motion.moving = true;
    setFocusedBlock(id);
    updateLocation(block.location);
    pinAnchor(blockAnchor(block));
    const current = live.current.mode;
    const cancelled = () => operation !== motion.operation;
    void Promise.all([
      current !== "translation"
        ? engine.current?.focusBlock?.(
            id,
            current === "parallel" ? "parallel" : "source",
          )
        : undefined,
      current !== "source" ? centerTranslation(id, cancelled) : undefined,
    ])
      .catch((e) => toast.error((e as Error).message))
      .finally(() => {
        if (cancelled()) return;
        setFocusedBlock(undefined);
        // Let the last programmatic scroll event pass before syncing resumes.
        requestAnimationFrame(() => {
          if (!cancelled()) {
            motion.moving = false;
            sync.current.following(origin);
          }
        });
      });
  };
  const cancelFocus = () => {
    const motion = focusMotion.current;
    if (!motion.moving) return;
    motion.operation++;
    motion.moving = false;
    setFocusedBlock(undefined);
    engine.current?.cancelBlockFocus?.();
  };
  const input = (origin: "source" | "translation") => {
    deferredFocus.cancel();
    translationMotion.current++;
    pendingFollow.current = undefined;
    syncTarget.current = undefined;
    cancelAnimationFrame(scrollFrame.current);
    cancelFocus();
    engine.current?.cancelBlockFocus?.();
    side.current = origin;
    sync.current.input(origin);
  };
  const updateLocation = (location: EPUBLocation) => {
    position.current = location;
    setChapter(location.href.split("#")[0]);
    const chapters = engine.current?.getEPUBChapters?.() ?? [];
    const index = chapters.findIndex(
      (c) => c.href === location.href.split("#")[0],
    );
    const current = live.current.blocks.filter(
      (b) => b.location.href === location.href.split("#")[0],
    );
    const block = epubBlocksAt(location, current)[0];
    const progress =
      location.progression ??
      (block ? current.indexOf(block) / Math.max(1, current.length) : 0);
    const weight = (c: (typeof chapters)[number]) => Math.max(1, c.characters);
    const preceding = chapters
      .slice(0, Math.max(0, index))
      .reduce((n, c) => n + weight(c), 0);
    const total = chapters.reduce((n, c) => n + weight(c), 0);
    live.current.events.location(
      location,
      Math.min(
        1,
        (preceding +
          progress * (chapters[index] ? weight(chapters[index]) : 1)) /
          Math.max(1, total),
      ),
    );
  };
  const go = async (location: DocumentLocation) => {
    if (location.type !== "epub") return;
    clear();
    input(
      live.current.mode === "translation" && !live.current.reflow
        ? "translation"
        : "source",
    );
    await engine.current?.goTo(location);
    const resolved = engine.current?.getLocation();
    if (
      resolved?.type === "epub" &&
      resolved.href === location.href.split("#")[0] &&
      resolved.blockId
    )
      location = resolved;
    updateLocation(location);
    pinAnchor(location);
    setChapter(location.href.split("#")[0]);
    const block = epubBlocksAt(location, live.current.blocks)[0];
    if (block) follow(block.id);
  };
  const step = async (direction: number) => {
    if (live.current.mode !== "translation" || live.current.reflow) {
      input("source");
      clear();
      return direction > 0
        ? engine.current?.next()
        : engine.current?.previous();
    }
    const order = engine.current?.getEPUBChapters?.().map((c) => c.href) ?? [];
    const href = order[order.indexOf(live.current.chapter) + direction];
    if (href) await go({ type: "epub", href });
  };
  const clear = () => {
    syncTarget.current = undefined;
    selection.current = null;
    engine.current?.clearSelection();
    window.getSelection()?.removeAllRanges();
    live.current.events.selection(null);
    void engine.current?.focusEPUBLocations?.([]);
  };
  const syncSource = async (location: EPUBLocation) => {
    if (live.current.mode !== "parallel") return;
    syncTarget.current = location;
    if (navigating.current) return;
    navigating.current = true;
    try {
      while (
        syncTarget.current &&
        live.current.mode === "parallel" &&
        side.current === "translation"
      ) {
        const target = syncTarget.current;
        syncTarget.current = undefined;
        await engine.current?.goTo({ ...target, quote: undefined });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      navigating.current = false;
    }
  };
  useEffect(() => {
    return () => {
      syncTarget.current = undefined;
      translationMotion.current++;
      focusMotion.current.operation++;
      cancelAnimationFrame(scrollFrame.current);
      cancelAnimationFrame(modeFrame.current);
    };
  }, [doc.id]);
  useLayoutEffect(() => {
    const anchor = viewportAnchor.current;
    viewportAnchor.current = undefined;
    const node = anchor && targetNode(anchor.id);
    if (node && pane.current)
      pane.current.scrollTop += node.getBoundingClientRect().top - anchor.top;
  }, [blocks]);
  useEffect(() => {
    if (pendingFollow.current)
      follow(pendingFollow.current.blockId, pendingFollow.current.fraction);
  }, [chapter, blocks, mode]);
  useEffect(() => {
    const host = pane.current;
    if (!host) return;
    return installTranslationSelectionHighlight(host);
  }, [chapter, mode]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !pane.current?.contains(event.target as Node) &&
        !isSelectionToolbar(event.target) &&
        selection.current?.location.translation
      )
        clear();
    };
    const changed = () => {
      if (
        selection.current?.location.translation &&
        !window.getSelection()?.toString().trim()
      ) {
        selection.current = null;
        void engine.current?.focusEPUBLocations?.([]);
        live.current.events.selection(null);
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("keydown", escape);
    };
  }, [events]);
  const reflowHost = () =>
    root.current?.querySelector<HTMLElement>(".epub-web-reader") ?? null;
  const capture = () => {
    dragging.current = false;
    const selected = window.getSelection();
    const host = live.current.reflow ? reflowHost() : pane.current;
    if (!selected?.rangeCount || selected.isCollapsed || !host) return;
    const range = selected.getRangeAt(0);
    if (
      !host.contains(range.startContainer) ||
      !host.contains(range.endContainer)
    )
      return;
    // Source text in the reflowed column belongs to the EPUB reader.
    const start =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    if (live.current.reflow && !start?.closest("[data-translation-block]"))
      return;
    const value = translatedSelection(host, range, visible, translations);
    if (!value || value.selection.location.type !== "epub") return;
    side.current = "translation";
    selection.current = value.selection;
    live.current.events.selection(value.selection);
    updateLocation(value.selection.location);
    pinAnchor(value.selection.location);
    if (!live.current.reflow) void syncSource(value.selection.location);
  };
  const scroll = () => {
    live.current.events.annotationHover?.(null);
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (
        focusMotion.current.moving ||
        !sync.current.canFollow("translation") ||
        dragging.current ||
        selection.current ||
        !pane.current
      )
        return;
      const top =
        pane.current.getBoundingClientRect().top +
        pane.current.clientHeight * 0.5;
      const node = Array.from(
        pane.current.querySelectorAll<HTMLElement>("[data-translation-block]"),
      ).find((n) => n.getBoundingClientRect().bottom > top);
      const block = live.current.blocks.find(
        (b) => b.id === node?.dataset.translationBlock,
      );
      if (block) {
        if (
          live.current.mode === "translation" &&
          block.location.href !== live.current.chapter
        )
          void engine.current
            ?.goTo(block.location)
            .catch((e) => toast.error(e.message));
        updateLocation(block.location);
        driftAnchor(blockAnchor(block));
        if (live.current.mode === "parallel" && node) {
          const rect = node.getBoundingClientRect();
          const anchor = {
            blockId: block.id,
            fraction: Math.max(
              0,
              Math.min(1, (top - rect.top) / (rect.height || 1)),
            ),
          };
          sync.current.following("source");
          void engine.current
            ?.followBlock?.(anchor)
            .catch((e) => toast.error(e.message));
        }
      }
    });
  };
  const changeMode = (value: Mode) => {
    clear();
    hover("source");
    hover("translation");
    setMode(value);
    // Reflowed text keeps the current paragraph centred once translations
    // appear or hide; hidden source text cannot hold a finer place.
    if (live.current.reflow) {
      input("source");
      const block = epubBlocksAt(position.current, live.current.blocks)[0];
      cancelAnimationFrame(modeFrame.current);
      modeFrame.current = requestAnimationFrame(() => {
        modeFrame.current = requestAnimationFrame(() => {
          if (block)
            void engine.current
              ?.followBlock?.({ blockId: block.id, fraction: 0.5 })
              .catch((e) => toast.error(e.message));
        });
      });
      return;
    }
    input(value === "translation" ? "translation" : "source");
    side.current = value === "translation" ? "translation" : "source";
    const target = position.current;
    cancelAnimationFrame(modeFrame.current);
    modeFrame.current = requestAnimationFrame(() => {
      if (value !== "source") {
        const block = epubBlocksAt(target, live.current.blocks)[0];
        if (block) follow(block.id);
      }
      if (target.href)
        void engine.current?.goTo(target).catch((e) => toast.error(e.message));
    });
  };
  const retry = (id = "") => {
    const block = live.current.blocks.find((b) => b.id === id);
    if (block) pinAnchor(blockAnchor(block));
    void api
      .translate(doc.id, id)
      .then(refreshChapter)
      .catch((e) => toast.error(e.message));
  };
  const toolbar = (
    <div className="translation-toolbar">
      <BookChapterControls
        documentId={doc.id}
        processing={processing}
        status={chapterStatus}
        stale={chapterStale}
        onRequest={async () => {
          const location = anchor ?? position.current;
          if (!location.href) throw new Error("正文仍在加载，请稍后再试");
          await api.translateEPUBChapter(doc.id, location);
        }}
        onChange={refreshChapter}
      />
      <Tabs value={mode} onValueChange={(value) => changeMode(value as Mode)}>
        <TabsList>
          <TabsTrigger value="source">仅原文</TabsTrigger>
          <TabsTrigger value="parallel">原文译文</TabsTrigger>
          <TabsTrigger value="translation">仅译文</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
  const sourceView = (
    <ReaderView
      active={active}
      document={doc}
      theme={theme}
      annotations={annotations}
      onReady={(adapter, toc) => {
        engine.current = adapter;
        setSentenceEngine(adapter);
        const initial = adapter.getLocation();
        if (initial?.type === "epub") {
          position.current = initial;
          if (initial.href) placeAnchor(initial);
          setChapter(initial.href.split("#")[0]);
        }
        const overrides: Partial<ReaderAdapter> = {
          goTo: go,
          next: () => step(1),
          previous: () => step(-1),
          clearSelection: clear,
          getSelection: () => selection.current,
          getLocation: () => position.current,
          getContext: async () => {
            const href = position.current.href.split("#")[0];
            const chapter = live.current.blocks.filter(
              (b) => b.location.href === href && !b.image,
            );
            return live.current.blocks.length
              ? chapter
                  .map((b) => b.text)
                  .join("\n\n")
                  .slice(0, 24000)
              : adapter.getContext();
          },
        };
        onReady(
          new Proxy(adapter, {
            get(target, key: keyof ReaderAdapter) {
              const value = overrides[key] ?? target[key];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
          toc,
        );
      }}
      events={{
        ...events,
        epubBlockAction: (block, action) => {
          const { reflow, translations, events } = live.current;
          if (reflow && action === "copy" && !block.image) {
            const translation = translations.find(
              (t) => t.blockId === block.id,
            );
            void copyText(reflowBlockText(block.text, translation), "已复制");
            return;
          }
          events.epubBlockAction?.(block, action);
        },
        epubBlocksChanged: (items) => {
          const top = pane.current?.getBoundingClientRect().top ?? 0;
          const node = Array.from(
            pane.current?.querySelectorAll<HTMLElement>(
              "[data-translation-block]",
            ) ?? [],
          ).find((n) => n.getBoundingClientRect().bottom > top);
          if (node)
            viewportAnchor.current = {
              id: node.dataset.translationBlock!,
              top: node.getBoundingClientRect().top,
            };
          live.current.blocks = items;
          setBlocks(items);
        },
        epubInteraction: () => {
          input("source");
          void engine.current?.focusEPUBLocations?.([]);
          if (selection.current?.location.translation) {
            selection.current = null;
            window.getSelection()?.removeAllRanges();
            live.current.events.selection(null);
          }
        },
        location: (location, percent) => {
          if (location.type !== "epub" || side.current === "translation")
            return;
          position.current = location;
          setChapter(location.href.split("#")[0]);
          driftAnchor(location);
          live.current.events.location(location, percent);
        },
        epubBlockHover: (id) => {
          if (live.current.mode === "parallel" && !live.current.reflow)
            hover("source", id ?? undefined);
        },
        epubBlockFocus: (id) => {
          // Clicking a paragraph focuses it unless the setting is off.
          if (theme.blockFocus === false) return;
          if (!live.current.reflow) focusBlock(id, "source");
          else
            void engine.current
              ?.focusBlock?.(id, "source")
              .catch((e) => toast.error((e as Error).message));
        },
        epubReadingAnchor: (id, fraction = 0.5) => {
          if (
            !focusMotion.current.moving &&
            sync.current.canFollow("source") &&
            !selection.current &&
            live.current.mode === "parallel"
          )
            follow(id, fraction, true);
        },
        selection: (value) => {
          if (!value && (side.current === "translation" || navigating.current))
            return;
          side.current = "source";
          selection.current = value;
          live.current.events.selection(value);
          if (value?.location.type === "epub") {
            pinAnchor(value.location);
            const matches = epubBlocksAt(value.location, live.current.blocks);
            if (matches[0] && live.current.mode === "parallel")
              follow(matches[0].id);
          }
        },
      }}
    />
  );
  return (
    <div
      ref={root}
      className="epub-reading"
      data-theme={theme.mode}
      style={{ "--epub-margin": `${theme.margin}px` } as CSSProperties}
    >
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {reflow ? (
        <div
          className="translation-source epub-reflow"
          data-reflow-mode={mode}
          style={
            {
              "--reflow-translation-font": translationFont(
                theme.translationFontFamily,
              ),
              "--reflow-translation-scale":
                (theme.translationFontSize ?? 1) / (theme.fontSize || 1),
              "--reflow-translation-weight":
                (theme.translationFontWeight ??
                  defaultTheme.translationFontWeight) === "bold"
                  ? 600
                  : "inherit",
            } as CSSProperties
          }
          onPointerUp={capture}
          onKeyUp={capture}
        >
          {sourceView}
          {[...companions].map(([id, node]) => {
            const block = blocks.find((b) => b.id === id);
            return (
              block &&
              createPortal(
                <TranslationText
                  block={block}
                  documentId={doc.id}
                  translation={translations.find((t) => t.blockId === id)}
                  paused={processing?.enabled === false}
                  retry={() => retry(id)}
                />,
                node,
                id,
              )
            );
          })}
        </div>
      ) : (
        <TranslationPanes
          mode={mode}
          swapped={swapped}
          onSwap={() => updateReaderLayout({ swapped: !swapped })}
          sourceWidth={sourceWidth}
          onSourceWidthChange={(sourceWidth) =>
            updateReaderLayout({ sourceWidth })
          }
          source={<div className="translation-source">{sourceView}</div>}
          translation={
            <div
              ref={pane}
              className="translation-document"
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
              onPointerDown={() => {
                live.current.events.annotationHover?.(null);
                input("translation");
                dragging.current = true;
              }}
              onPointerUp={capture}
              onKeyUp={capture}
              onWheel={() => input("translation")}
              onTouchStart={() => input("translation")}
              onKeyDown={() => input("translation")}
              onScroll={scroll}
              onClick={(event) => {
                if (window.getSelection()?.toString().trim() || !pane.current)
                  return;
                const hits = translatedAnnotationRanges(
                  pane.current,
                  annotations,
                  translations,
                ).filter(({ range }) =>
                  Array.from(range.getClientRects()).some(
                    (r) =>
                      event.clientX >= r.left &&
                      event.clientX <= r.right &&
                      event.clientY >= r.top &&
                      event.clientY <= r.bottom,
                  ),
                );
                live.current.events.annotation?.(
                  hits.length
                    ? {
                        ids: hits.map((h) => h.annotation.id),
                        anchor: {
                          x: event.clientX,
                          top: event.clientY - 8,
                          bottom: event.clientY + 8,
                        },
                      }
                    : null,
                );
              }}
            >
              {(streamError ||
                processing?.status === "waiting" ||
                processing?.status === "failed") && (
                <div className="translation-warning">
                  {streamError || processing?.detail}
                  {processing?.status === "failed" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void api
                          .setAssistance(doc.id, "resume")
                          .catch((e) => toast.error(e.message))
                      }
                    >
                      重试翻译
                    </Button>
                  )}
                </div>
              )}
              {!blocks.length && (
                <p className="translation-warning">
                  {processing?.status === "complete"
                    ? "此书没有可翻译的正文文字"
                    : "正在读取正文段落…"}
                </p>
              )}
              {visible.map((block) => (
                <section
                  key={block.id}
                  data-translation-block={block.id}
                  data-block-kind={block.image ? "image" : "text"}
                  data-label={block.label}
                  data-chapter={block.location.href}
                  data-hovered={hoveredBlock === block.id || undefined}
                  data-focused={focusedBlock === block.id || undefined}
                  aria-current={focusedBlock === block.id || undefined}
                  tabIndex={0}
                  onPointerDown={(event) => {
                    cancelFocus();
                    pressedBlock.current =
                      event.button === 0
                        ? { id: block.id, x: event.clientX, y: event.clientY }
                        : undefined;
                  }}
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
                          focusBlock(block.id, "translation");
                      });
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      focusBlock(block.id, "translation");
                    }
                  }}
                  onPointerEnter={(event) => {
                    if (!event.buttons && !dragging.current)
                      hover("translation", block.id);
                  }}
                  onPointerMove={(event) => {
                    if (!event.buttons && !dragging.current)
                      hover("translation", block.id);
                  }}
                  onPointerLeave={() => hover("translation")}
                >
                  <TranslationText
                    block={block}
                    imageURL={
                      block.image
                        ? publicationURL(doc.id, block.image)
                        : undefined
                    }
                    documentId={doc.id}
                    translation={translations.find(
                      (t) => t.blockId === block.id,
                    )}
                    paused={processing?.enabled === false}
                    retry={() => retry(block.id)}
                  />
                </section>
              ))}
            </div>
          }
        />
      )}
    </div>
  );
}
