import { annotationsInRects, sentenceRectsAtPoint } from "./annotation-hover";
import { useTranslations } from "./useTranslations";
import {
  useEffect,
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
} from "@reader/core";
import { api, publicationURL } from "@reader/api";
import { Tabs, TabsList, TabsTrigger } from "@reader/ui/components/tabs";
import { Button } from "@reader/ui/components/button";
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
import { epubBlocksAt, epubOffsets, epubSentenceLocation } from "./epub-links";
import { isSelectionToolbar } from "../readers/selection-anchor";
import { defaultTheme } from "@reader/core";
import { translationFont } from "../appearance";
import "./translation.css";

type Mode = "source" | "parallel" | "translation";
export function EPUBReadingView({
  document: doc,
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
  const [swapped, setSwapped] = useState(false);
  const [blocks, setBlocks] = useState<EPUBReadingBlock[]>([]);
  const { translations, error: streamError } = useTranslations(doc.id);
  const [chapter, setChapter] = useState(
    doc.progress?.type === "epub" ? doc.progress.href : "",
  );
  const [error, setError] = useState("");
  const [linked, setLinked] = useState<Record<string, number[]>>({});
  const pane = useRef<HTMLDivElement>(null);
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
  const updateLocation = (location: EPUBLocation) => {
    position.current = location;
    setChapter(location.href.split("#")[0]);
    const all = live.current.blocks;
    const block = epubBlocksAt(location, all)[0];
    live.current.events.location(
      location,
      block ? all.indexOf(block) / Math.max(1, all.length) : 0,
    );
  };
  const go = async (location: DocumentLocation) => {
    if (location.type !== "epub") return;
    clear();
    side.current =
      live.current.mode === "translation" ? "translation" : "source";
    const navigateSource =
      live.current.mode !== "translation" || location.href.includes("#");
    if (navigateSource) await engine.current?.goTo(location);
    const resolved = navigateSource ? engine.current?.getLocation() : undefined;
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
    const order = [...new Set(live.current.blocks.map((b) => b.location.href))];
    const href = order[order.indexOf(live.current.chapter) + direction];
    const block = live.current.blocks.find((b) => b.location.href === href);
    if (block) await go(block.location);
  };
  const clear = () => {
    syncTarget.current = undefined;
    selection.current = null;
    engine.current?.clearSelection();
    window.getSelection()?.removeAllRanges();
    live.current.events.selection(null);
    setLinked({});
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
    const controller = new AbortController();
    void api
      .epubBlocks(doc.id)
      .then((items) => {
        if (controller.signal.aborted) return;
        setBlocks(items);
        engine.current?.setEPUBBlocks?.(items);
        setChapter((current) =>
          items.some((b) => b.location.href === current)
            ? current
            : (items[0]?.location.href ?? ""),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      syncTarget.current = undefined;
      cancelAnimationFrame(scrollFrame.current);
      cancelAnimationFrame(modeFrame.current);
    };
  }, [doc.id]);
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
        setLinked({});
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
    setLinked(
      Object.fromEntries(
        value.links.map((l) => [l.blockId, l.sentenceIndexes]),
      ),
    );
    updateLocation(value.selection.location);
    void syncSource(value.selection.location);
    if (live.current.mode === "parallel")
      void engine.current
        ?.focusEPUBLocations?.(
          value.selection.location.translation?.ranges?.flatMap((r) =>
            r.location ? [r.location] : [],
          ) ?? [value.selection.location],
        )
        .catch((e) => toast.error(e.message));
  };
  const scroll = () => {
    live.current.events.annotationHover?.(null);
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (
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
        updateLocation(block.location);
        void syncSource(block.location);
      }
    });
  };
  const changeMode = (value: Mode) => {
    clear();
    setMode(value);
    side.current = value === "translation" ? "translation" : "source";
    const target = position.current;
    cancelAnimationFrame(modeFrame.current);
    modeFrame.current = requestAnimationFrame(() => {
      if (value !== "source") {
        const block = epubBlocksAt(target, live.current.blocks)[0];
        if (block) follow(block.id);
      }
      if (value !== "translation" && target.href)
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
        onSwap={() => setSwapped((v) => !v)}
        source={
          <div className="translation-source">
            <ReaderView
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
                adapter.setEPUBBlocks?.(live.current.blocks);
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
                  setChapter(location.href);
                  live.current.events.location(location, percent);
                },
                epubReadingAnchor: (id) => {
                  if (
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
                    const selectedRange = epubOffsets(value.location);
                    const links = Object.fromEntries(
                      matches.map((block) => {
                        const translated = live.current.translations.find(
                          (t) => t.blockId === block.id,
                        );
                        const indexes =
                          translated?.sentences.flatMap((_, index) => {
                            const range = epubOffsets(
                              epubSentenceLocation(
                                block,
                                translated.sentences,
                                [index],
                              ),
                            );
                            return !selectedRange ||
                              !range ||
                              (range.start < selectedRange.end &&
                                selectedRange.start < range.end)
                              ? [index]
                              : [];
                          }) ?? [];
                        return [block.id, indexes];
                      }),
                    );
                    setLinked(links);
                    if (matches[0] && live.current.mode === "parallel")
                      follow(matches[0].id);
                  } else setLinked({});
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
            {(error ||
              streamError ||
              processing?.status === "waiting" ||
              processing?.status === "failed") && (
              <div className="translation-warning">
                {error || streamError || processing?.detail}
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
                {error ||
                  (processing?.status === "complete"
                    ? "此书没有可翻译的正文文字"
                    : "正在读取正文段落…")}
              </p>
            )}
            {visible.map((block) => (
              <section
                key={block.id}
                data-translation-block={block.id}
                data-label={block.label}
                data-chapter={block.location.href}
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
                  linked={linked[block.id]}
                />
              </section>
            ))}
          </div>
        }
      />
    </div>
  );
}
