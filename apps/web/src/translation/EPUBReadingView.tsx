import { annotationsInRects, sentenceRectsAtPoint } from "./annotation-hover";
import { useTranslations } from "./useTranslations";
import { readerLayout, updateReaderLayout } from "../neoread-layout";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  DocumentLocation,
  EPUBLocation,
  EPUBReadingBlock,
  ReaderAdapter,
  ReaderSelection,
  Processing,
} from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import { Button } from "@neoread/ui/components/button";
import { toast } from "sonner";
import { ReaderView } from "../ReaderView";
import { AssistanceControls } from "./AssistanceControls";
import { TranslationPanes } from "./TranslationPanes";
import { TranslationText } from "./TranslationText";
import { translatedSelection } from "./selection";
import {
  paintTranslatedAnnotations,
  translatedAnnotationRanges,
} from "./annotations";
import { installTranslationSelectionHighlight } from "./selection-highlight";
import { epubBlocksAt } from "./epub-links";
import { animatePDFScroll } from "../readers/pdf-scroll";
import { isSelectionToolbar } from "../readers/selection-anchor";
import { defaultTheme } from "@neoread/core";
import { translationFont } from "../appearance";
import "./translation.css";

type Mode = "source" | "parallel" | "translation";
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
  const { swapped, sourceWidth } = readerLayout(theme.readerLayout);
  const [blocks, setBlocks] = useState<EPUBReadingBlock[]>([]);
  const [chapter, setChapter] = useState(
    doc.progress?.type === "epub" ? doc.progress.href.split("#")[0] : "",
  );
  const { translations, error: streamError } = useTranslations(doc.id, [
    ...new Set(blocks.map((b) => b.location.href)),
  ]);
  const pane = useRef<HTMLDivElement>(null);
  const viewportAnchor = useRef<{ id: string; top: number } | undefined>(
    undefined,
  );
  const engine = useRef<ReaderAdapter | undefined>(undefined);
  const selection = useRef<ReaderSelection | null>(null);
  const position = useRef<EPUBLocation>(
    doc.progress?.type === "epub" ? doc.progress : { type: "epub", href: "" },
  );
  const side = useRef<"source" | "translation">("source");
  const navigating = useRef(false);
  const syncTarget = useRef<EPUBLocation | undefined>(undefined);
  const pendingFollow = useRef<string | undefined>(undefined);
  const scrollFrame = useRef(0);
  const modeFrame = useRef(0);
  const dragging = useRef(false);
  const [hoveredBlock, setHoveredBlock] = useState<string>();
  const [focusedBlock, setFocusedBlock] = useState<string>();
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const pressedBlock = useRef<{ id: string; x: number; y: number }>(undefined);
  // An explicit block focus owns both panes until its motion settles.
  const focusMotion = useRef({ operation: 0, moving: false });
  const live = useRef({
    mode,
    blocks,
    translations,
    events,
    annotations,
    chapter,
  });
  live.current = { mode, blocks, translations, events, annotations, chapter };
  const visible = blocks;
  const targetNode = (id: string) =>
    Array.from(
      pane.current?.querySelectorAll<HTMLElement>("[data-translation-block]") ??
        [],
    ).find((n) => n.dataset.translationBlock === id);
  const follow = (id: string) => {
    const block = live.current.blocks.find((b) => b.id === id);
    if (!block) return;
    pendingFollow.current = id;
    if (block.location.href !== live.current.chapter)
      setChapter(block.location.href);
    else {
      const node = targetNode(id),
        host = pane.current;
      if (node && host) {
        host.scrollTop +=
          node.getBoundingClientRect().top -
          host.getBoundingClientRect().top -
          host.clientHeight * 0.25;
        pendingFollow.current = undefined;
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
    side.current = origin;
    syncTarget.current = undefined;
    pendingFollow.current = undefined;
    const motion = focusMotion.current;
    const operation = ++motion.operation;
    motion.moving = true;
    setFocusedBlock(id);
    updateLocation(block.location);
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
          if (!cancelled()) motion.moving = false;
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
    side.current =
      live.current.mode === "translation" ? "translation" : "source";
    await engine.current?.goTo(location);
    const resolved = engine.current?.getLocation();
    if (
      resolved?.type === "epub" &&
      resolved.href === location.href.split("#")[0] &&
      resolved.blockId
    )
      location = resolved;
    updateLocation(location);
    setChapter(location.href.split("#")[0]);
    const block = epubBlocksAt(location, live.current.blocks)[0];
    if (block) follow(block.id);
  };
  const step = async (direction: number) => {
    if (live.current.mode !== "translation") {
      side.current = "source";
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
    if (pendingFollow.current) follow(pendingFollow.current);
  }, [chapter, blocks, mode]);
  useEffect(() => {
    const host = pane.current;
    if (!host) return;
    const compact = installTranslationSelectionHighlight(host);
    let clean: (() => void) | undefined;
    const paint = () => {
      clean?.();
      clean = paintTranslatedAnnotations(host, annotations, translations);
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(host, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      clean?.();
      compact?.();
    };
  }, [annotations, translations, chapter]);
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
  const capture = () => {
    dragging.current = false;
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed || !pane.current) return;
    const range = selected.getRangeAt(0);
    if (
      !pane.current.contains(range.startContainer) ||
      !pane.current.contains(range.endContainer)
    )
      return;
    const value = translatedSelection(
      pane.current,
      range,
      visible,
      translations,
    );
    if (!value || value.selection.location.type !== "epub") return;
    side.current = "translation";
    selection.current = value.selection;
    live.current.events.selection(value.selection);
    updateLocation(value.selection.location);
    void syncSource(value.selection.location);
  };
  const scroll = () => {
    live.current.events.annotationHover?.(null);
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (
        focusMotion.current.moving ||
        side.current !== "translation" ||
        dragging.current ||
        selection.current ||
        !pane.current
      )
        return;
      const top =
        pane.current.getBoundingClientRect().top +
        pane.current.clientHeight * 0.25;
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
        void syncSource(block.location);
      }
    });
  };
  const changeMode = (value: Mode) => {
    clear();
    cancelFocus();
    hover("source");
    hover("translation");
    setMode(value);
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
    void api.translate(doc.id, id).catch((e) => toast.error(e.message));
  };
  const toolbar = (
    <div className="translation-toolbar">
      <AssistanceControls
        documentId={doc.id}
        processing={processing}
        library="books"
        epubChapter={() => position.current}
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
  return (
    <div className="epub-reading" data-theme={theme.mode}>
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      <TranslationPanes
        mode={mode}
        swapped={swapped}
        onSwap={() => updateReaderLayout({ swapped: !swapped })}
        sourceWidth={sourceWidth}
        onSourceWidthChange={(sourceWidth) =>
          updateReaderLayout({ sourceWidth })
        }
        source={
          <div className="translation-source">
            <ReaderView
              active={active}
              document={doc}
              theme={theme}
              annotations={annotations}
              onReady={(adapter, toc) => {
                engine.current = adapter;
                const initial = adapter.getLocation();
                if (initial?.type === "epub") {
                  position.current = initial;
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
                      return typeof value === "function"
                        ? value.bind(target)
                        : value;
                    },
                  }),
                  toc,
                );
              }}
              events={{
                ...events,
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
                  side.current = "source";
                  syncTarget.current = undefined;
                  void engine.current?.focusEPUBLocations?.([]);
                  if (selection.current?.location.translation) {
                    selection.current = null;
                    window.getSelection()?.removeAllRanges();
                    live.current.events.selection(null);
                  }
                },
                location: (location, percent) => {
                  if (
                    location.type !== "epub" ||
                    side.current === "translation"
                  )
                    return;
                  position.current = location;
                  setChapter(location.href.split("#")[0]);
                  live.current.events.location(location, percent);
                },
                epubBlockHover: (id) => {
                  if (live.current.mode === "parallel")
                    hover("source", id ?? undefined);
                },
                epubBlockFocus: (id) => focusBlock(id, "source"),
                epubReadingAnchor: (id) => {
                  if (
                    !focusMotion.current.moving &&
                    side.current === "source" &&
                    live.current.mode === "parallel"
                  )
                    follow(id);
                },
                selection: (value) => {
                  if (
                    !value &&
                    (side.current === "translation" || navigating.current)
                  )
                    return;
                  side.current = "source";
                  selection.current = value;
                  live.current.events.selection(value);
                  if (value?.location.type === "epub") {
                    const matches = epubBlocksAt(
                      value.location,
                      live.current.blocks,
                    );
                    if (matches[0] && live.current.mode === "parallel")
                      follow(matches[0].id);
                  }
                },
              }}
            />
          </div>
        }
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
            onPointerMove={(event) => {
              const target =
                event.target instanceof Element ? event.target : null;
              if (
                !pane.current ||
                !target ||
                event.buttons ||
                window.getSelection()?.toString().trim() ||
                target.closest("a,button,input,textarea")
              ) {
                live.current.events.annotationHover?.(null);
                return;
              }
              const rects = sentenceRectsAtPoint(
                target,
                event.clientX,
                event.clientY,
              );
              const marks = translatedAnnotationRanges(
                pane.current,
                annotations,
                translations,
              );
              const matches = annotationsInRects(
                pane.current,
                annotations,
                marks,
                rects,
              );
              live.current.events.annotationHover?.(
                matches.length
                  ? {
                      ids: matches.map((a) => a.id),
                      anchor: {
                        x: event.clientX,
                        top: Math.min(...rects.map((r) => r.top)),
                        bottom: Math.max(...rects.map((r) => r.bottom)),
                      },
                    }
                  : null,
              );
            }}
            onPointerLeave={() => live.current.events.annotationHover?.(null)}
            onPointerDown={() => {
              live.current.events.annotationHover?.(null);
              side.current = "translation";
              dragging.current = true;
            }}
            onPointerUp={capture}
            onKeyUp={capture}
            onWheel={() => {
              side.current = "translation";
              cancelFocus();
            }}
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
                  focusBlock(block.id, "translation");
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
                  translation={translations.find((t) => t.blockId === block.id)}
                  paused={processing?.enabled === false}
                  retry={() => retry(block.id)}
                />
              </section>
            ))}
          </div>
        }
      />
    </div>
  );
}
