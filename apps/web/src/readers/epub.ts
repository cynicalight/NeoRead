import { selectionContext } from "./selection-context";
import { forwardReaderShortcut } from "../shortcuts/shortcuts";
import {
  installEPUBPaging,
  installEPUBScroll,
  type EPUBScrollState,
} from "./epub-scroll";
import { EPUBTransition } from "./epub-transition";
import { toast } from "sonner";
import { selectionAnchor, isSelectionToolbar } from "./selection-anchor";
import {
  selectionLocator,
  sliceEPUBRange,
  resolveEPUBRange,
  searchEPUBLocators,
} from "./selection-locator";
import { installScrollbars } from "../scrollbars";
import {
  EpubNavigator,
  EpubPreferences,
  DecorationLayout,
  DecorationWidth,
  type Decoration,
  type DecorationObserver,
  type EpubNavigatorListeners,
} from "@readium/navigator";
import {
  HttpFetcher,
  Locator,
  Manifest,
  Publication,
  type Link,
} from "@readium/shared";
import { api, publicationURL } from "@reader/api";
import type {
  Annotation,
  Document,
  DocumentLocation,
  EPUBLocation,
  EPUBReadingBlock,
  ReaderAdapter,
  ReaderEvents,
  ReaderSelection,
  ReaderTheme,
  SelectionAnchor,
  SearchResult,
  TOCItem,
} from "@reader/core";
import { selectSentence, sentenceRoot } from "./sentence-selection";
export class EPUBReaderAdapter implements ReaderAdapter {
  private navigator?: EpubNavigator;
  private publication?: Publication;
  private location: EPUBLocation = { type: "epub", href: "" };
  private selection: ReaderSelection | null = null;
  private doc?: Document;
  private disposed = false;
  private abort = new AbortController();
  private resourceDocuments = new Map<string, Promise<globalThis.Document>>();
  private highlightRevision = 0;
  private focusRevision = 0;
  private unresolvedAnnotations = "";
  private decorationAnnotations = new Map<string, string>();
  private annotationId(id: string) {
    return this.decorationAnnotations.get(id) ?? id;
  }
  private scrollState: EPUBScrollState = {
    busy: false,
    locked: false,
    lastInput: 0,
    direction: 0,
  };
  private paginated = false;
  private loaded = false;
  private transition: EPUBTransition;
  private frameCleanups = new Map<Window, () => void>();
  private pointers = new WeakMap<Window, { x: number; y: number }>();
  private selectedWindow?: Window;
  private annotations: Annotation[] = [];
  private readingBlocks: EPUBReadingBlock[] = [];
  private readingFrame = 0;
  private lastReadingBlock = "";
  setEPUBBlocks(blocks: EPUBReadingBlock[]) {
    this.readingBlocks = blocks;
    this.reportReadingBlock();
  }
  private reportReadingBlock = () => {
    cancelAnimationFrame(this.readingFrame);
    this.readingFrame = requestAnimationFrame(() => {
      if (this.disposed) return;
      const wnd = this.navigator?._cframes[0]?.iframe.contentWindow;
      if (!wnd) return;
      const candidates = this.readingBlocks.filter(
        (b) => b.location.href === this.location.href,
      );
      let chosen: string | undefined,
        distance = Infinity;
      for (const block of candidates) {
        const locator = this.toLocator(block.location);
        const range = resolveEPUBRange(wnd.document, locator);
        if (!range) continue;
        for (const rect of Array.from(range.getClientRects())) {
          if (
            rect.right <= 0 ||
            rect.left >= wnd.innerWidth ||
            rect.bottom <= 0 ||
            rect.top >= wnd.innerHeight
          )
            continue;
          const delta = Math.abs(rect.top - wnd.innerHeight * 0.25);
          if (delta < distance) {
            chosen = block.id;
            distance = delta;
          }
        }
      }
      if (chosen && chosen !== this.lastReadingBlock) {
        this.lastReadingBlock = chosen;
        this.events.epubReadingAnchor?.(chosen);
      }
    });
  };
  private annotationAnchor?: SelectionAnchor;
  private hoverAllowed = false;
  private hoveredAnnotation?: string;
  private clearAnnotationHover = () => {
    if (!this.hoveredAnnotation) return;
    this.hoveredAnnotation = undefined;
    this.navigator?.applyDecorations([], "annotation-hover");
  };
  private annotationObserver: DecorationObserver = {
    onDecorationActivated: ({ decoration }) => {
      if (
        this.disposed ||
        !this.annotationAnchor ||
        this.hasTextSelection() ||
        !this.annotations.some((a) => a.id === this.annotationId(decoration.id))
      )
        return false;
      this.events.annotation?.({
        ids: [this.annotationId(decoration.id)],
        anchor: this.annotationAnchor,
      });
      this.annotationAnchor = undefined;
      return true;
    },
    onDecorationPointerEnter: ({ decoration }) => {
      if (
        this.disposed ||
        !this.hoverAllowed ||
        this.hasTextSelection() ||
        !this.annotations.some((a) => a.id === this.annotationId(decoration.id))
      )
        return;
      this.hoveredAnnotation = decoration.id;
      this.navigator?.applyDecorations(
        [
          {
            id: decoration.id,
            locator: decoration.locator,
            style: {
              type: "template",
              layout: DecorationLayout.Boxes,
              width: DecorationWidth.Wrap,
              element: () =>
                '<div style="background:rgba(230,185,76,0.18);border-radius:2px;"></div>',
            },
          },
        ],
        "annotation-hover",
      );
    },
    onDecorationPointerLeave: ({ decoration }) => {
      if (this.hoveredAnnotation === decoration.id) this.clearAnnotationHover();
    },
  };
  private hasTextSelection() {
    return Array.from(this.container.querySelectorAll("iframe")).some((frame) =>
      frame.contentWindow?.getSelection()?.toString().trim(),
    );
  }
  private resize: ResizeObserver;
  constructor(
    private container: HTMLElement,
    private events: ReaderEvents,
  ) {
    document.addEventListener("pointerdown", this.onOutsidePointer);
    document.addEventListener("keydown", this.onKeyDown);
    this.resize = new ResizeObserver(this.clearSelection);
    this.resize.observe(container);
    this.transition = new EPUBTransition(container);
  }
  /** Read before open so the first layout already uses the saved flow. */
  preferTheme(theme: ReaderTheme) {
    this.paginated = theme.epubFlow === "paginated";
  }
  private clearState = () => {
    this.selectedWindow = undefined;
    if (!this.selection) return;
    this.selection = null;
    this.events.selection(null);
  };
  clearSelection = () => {
    this.annotationAnchor = undefined;
    this.hoverAllowed = false;
    this.clearAnnotationHover();
    this.events.annotation?.(null);
    for (const frame of this.container.querySelectorAll("iframe"))
      frame.contentWindow?.getSelection()?.removeAllRanges();
    this.clearState();
  };
  private onOutsidePointer = (event: PointerEvent) => {
    if (!isSelectionToolbar(event.target)) this.clearSelection();
  };
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.clearSelection();
  };
  private bindFrame = (wnd: Window) => {
    this.frameCleanups.get(wnd)?.();
    const doc = wnd.document;
    const interact = () => this.events.epubInteraction?.();
    this.reportReadingBlock();
    let pressed: { x: number; y: number } | undefined;
    const annotationPress = (event: PointerEvent) => {
      this.annotationAnchor = undefined;
      this.hoverAllowed = false;
      this.clearAnnotationHover();
      this.events.annotation?.(null);
      pressed =
        event.button === 0 &&
        !(event.target as Element | null)?.closest?.(
          "a, button, input, textarea, select",
        )
          ? { x: event.clientX, y: event.clientY }
          : undefined;
    };
    const annotationRelease = (event: PointerEvent) => {
      this.annotationAnchor = undefined;
      if (
        pressed &&
        event.button === 0 &&
        Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) <= 5 &&
        !this.hasTextSelection()
      ) {
        const frame = Array.from(
          this.container.querySelectorAll("iframe"),
        ).find((f) => f.contentWindow === wnd);
        if (frame) {
          const bounds = frame.getBoundingClientRect();
          const sx = frame.offsetWidth ? bounds.width / frame.offsetWidth : 1;
          const sy = frame.offsetHeight
            ? bounds.height / frame.offsetHeight
            : 1;
          this.annotationAnchor = {
            x: bounds.left + (frame.clientLeft + event.clientX) * sx,
            top: bounds.top + (frame.clientTop + event.clientY - 8) * sy,
            bottom: bounds.top + (frame.clientTop + event.clientY + 8) * sy,
          };
        }
      }
      pressed = undefined;
    };
    const annotationMove = (event: PointerEvent) => {
      this.hoverAllowed = !event.buttons && !this.hasTextSelection();
      if (!this.hoverAllowed) this.clearAnnotationHover();
    };
    const annotationLeave = () => {
      this.hoverAllowed = false;
      this.clearAnnotationHover();
    };
    const removeScrollbars = installScrollbars(doc);
    const current = () =>
      !this.disposed &&
      !!this.navigator?._cframes.some((f) => f?.iframe.contentWindow === wnd);
    const turn = (direction: number) =>
      direction > 0 ? this.next() : this.previous();
    const failed = (reason: unknown) =>
      toast.error(
        reason instanceof Error ? reason.message : "无法读取相邻章节",
      );
    const removeContinuousScroll = installEPUBScroll(
      wnd,
      this.scrollState,
      () => current() && !this.paginated,
      turn,
      failed,
    );
    const removePaging = installEPUBPaging(
      wnd,
      this.scrollState,
      () => current() && this.paginated,
      turn,
      failed,
    );
    const changed = () => {
      const selected = wnd.getSelection();
      if (
        this.selectedWindow === wnd &&
        (!selected?.rangeCount ||
          selected.isCollapsed ||
          !selected.toString().trim())
      )
        this.clearState();
    };
    const start = () => {
      this.pointers.delete(wnd);
      this.clearState();
    };
    const released = (event: MouseEvent) => {
      // A double click selects the whole sentence instead of one word.
      if (event.detail === 2) {
        const selection = doc.getSelection();
        const root = sentenceRoot(selection?.anchorNode ?? null);
        if (root) selectSentence(selection, root);
      }
      this.pointers.set(wnd, { x: event.clientX, y: event.clientY });
      changed();
    };
    const key = (event: KeyboardEvent) => {
      forwardReaderShortcut(event);
      this.pointers.delete(wnd);
      this.onKeyDown(event);
    };
    const keyReleased = (event: KeyboardEvent) => {
      if (event.key === "Escape" || this.disposed) return;
      const selection = wnd.getSelection();
      if (
        !selection?.rangeCount ||
        selection.isCollapsed ||
        !selection.toString().trim()
      )
        return;
      const manager = this.navigator?._cframes.find(
        (f) => f?.iframe.contentWindow === wnd,
      );
      const rect = selection.getRangeAt(0).getClientRects()[0];
      if (!manager || !rect) return;
      this.navigator?.eventListener(
        "text_selected",
        {
          text: selection.toString(),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          targetFrameSrc: manager.source,
        },
        manager,
      );
    };
    const unload = () => {
      this.clearSelection();
      if (this.selectedWindow === wnd) this.clearState();
      cleanup();
      this.frameCleanups.delete(wnd);
    };
    const cleanup = () => {
      removeScrollbars();
      removeContinuousScroll();
      removePaging();
      doc.removeEventListener("pointerdown", annotationPress, true);
      doc.removeEventListener("pointerup", annotationRelease, true);
      doc.removeEventListener("pointermove", annotationMove, true);
      doc.removeEventListener("pointerleave", annotationLeave);
      doc.removeEventListener("selectionchange", changed);
      doc.removeEventListener("pointerdown", start);
      doc.removeEventListener("mouseup", released);
      doc.removeEventListener("keydown", key);
      doc.removeEventListener("keyup", keyReleased);
      doc.removeEventListener("scroll", this.clearSelection, true);
      doc.removeEventListener("scroll", this.reportReadingBlock, true);
      for (const event of ["pointerdown", "wheel", "keydown"])
        doc.removeEventListener(event, interact, true);
      wnd.removeEventListener("pagehide", unload);
    };
    doc.addEventListener("selectionchange", changed);
    doc.addEventListener("pointerdown", annotationPress, true);
    doc.addEventListener("pointerup", annotationRelease, true);
    doc.addEventListener("pointermove", annotationMove, true);
    doc.addEventListener("pointerleave", annotationLeave);
    doc.addEventListener("pointerdown", start);
    doc.addEventListener("mouseup", released);
    doc.addEventListener("keydown", key);
    doc.addEventListener("keyup", keyReleased);
    doc.addEventListener("scroll", this.clearSelection, true);
    doc.addEventListener("scroll", this.reportReadingBlock, true);
    for (const event of ["pointerdown", "wheel", "keydown"])
      doc.addEventListener(event, interact, { capture: true, passive: true });
    wnd.addEventListener("pagehide", unload);
    this.frameCleanups.set(wnd, cleanup);
  };
  private fromLocator(locator: Locator): EPUBLocation {
    return {
      type: "epub",
      href: locator.href,
      locator: JSON.stringify(locator.serialize()),
      progression: locator.locations.progression,
      quote: locator.text?.highlight,
    };
  }
  private toLocator(location: EPUBLocation): Locator {
    if (location.locator) {
      try {
        const locator = Locator.deserialize(JSON.parse(location.locator));
        if (locator) {
          if (locator.href.split("#")[0] !== location.href.split("#")[0])
            throw new Error("批注章节与原文位置不一致");
          if (!locator.text?.highlight && location.quote)
            return Locator.deserialize({
              ...locator.serialize(),
              text: { ...locator.text?.serialize(), highlight: location.quote },
            })!;
          return locator;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        /* Legacy malformed locators can still recover from href and quote. */
      }
    }
    return Locator.deserialize({
      href: location.href.split("#")[0],
      type: "application/xhtml+xml",
      locations: {
        progression: location.progression,
        fragments: location.href.includes("#")
          ? [location.href.split("#")[1]]
          : [],
      },
      text: { highlight: location.quote },
    })!;
  }
  private resourceDocument(href: string): Promise<globalThis.Document> {
    const resource = href.split("#")[0]!;
    if (!this.doc || !this.publication?.readingOrder.findWithHref(resource))
      return Promise.reject(new Error("该章节不属于当前书籍"));
    let pending = this.resourceDocuments.get(resource);
    if (!pending) {
      pending = fetch(publicationURL(this.doc.id, resource), {
        signal: this.abort.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("无法读取 EPUB 章节");
          return new DOMParser().parseFromString(
            await response.text(),
            "text/html",
          );
        })
        .catch((error) => {
          this.resourceDocuments.delete(resource);
          throw error;
        });
      this.resourceDocuments.set(resource, pending);
    }
    return pending;
  }
  private async exactLocator(location: EPUBLocation): Promise<Locator> {
    const locator = this.toLocator(location);
    if (!locator.text?.highlight) return locator;
    const doc = await this.resourceDocument(locator.href);
    let range = resolveEPUBRange(doc, locator);
    const slice = locator.locations.otherLocations?.get("sourceSlice") as
      { start: number; end: number } | undefined;
    if (range && slice) range = sliceEPUBRange(range, slice.start, slice.end);
    const exact = range && selectionLocator(locator, range);
    exact?.locations.otherLocations?.delete("sourceSlice");
    if (!exact)
      throw new Error("未能唯一定位这段原文，笔记已保留。请使用书内搜索。");
    return exact;
  }
  private navigate(locator: Locator): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.abort.signal.removeEventListener("abort", cancelled);
        error ? reject(error) : resolve();
      };
      const cancelled = () =>
        finish(new DOMException("阅读器已关闭", "AbortError"));
      const timeout = setTimeout(
        () => finish(new Error("章节跳转超时，请重试")),
        10000,
      );
      this.abort.signal.addEventListener("abort", cancelled, { once: true });
      if (this.disposed) return cancelled();
      try {
        this.navigator!.go(locator, false, (ok) =>
          finish(ok ? undefined : new Error("无法跳转到该位置")),
        );
      } catch (error) {
        finish(error as Error);
      }
    });
  }
  async open(doc: Document) {
    this.doc = doc;
    const url = new URL(
      publicationURL(doc.id, "manifest.json"),
      window.location.origin,
    ).href;
    const response = await fetch(url, { signal: this.abort.signal });
    if (!response.ok) throw new Error("无法加载 EPUB 目录");
    const json = await response.json();
    json.links = [
      { rel: "self", href: url, type: "application/webpub+json" },
      {
        rel: "http://readium.org/positions",
        href: "positions.json",
        type: "application/vnd.readium.position-list+json",
      },
    ];
    const manifest = Manifest.deserialize(json);
    if (!manifest) throw new Error("EPUB manifest 无效");
    this.publication = new Publication({
      manifest,
      fetcher: new HttpFetcher(undefined, url),
    });
    const positions = await this.publication.positionsFromManifest();
    if (this.disposed) return;
    if (!positions.length) throw new Error("EPUB 阅读位置为空，无法打开正文");
    const listeners: EpubNavigatorListeners = {
      frameLoaded: this.bindFrame,
      positionChanged: (locator) => {
        this.clearSelection();
        this.location = this.fromLocator(locator);
        this.reportReadingBlock();
        const index = this.publication!.readingOrder.items.findIndex(
          (l) => l.href === locator.href,
        );
        const percent =
          locator.locations.totalProgression ??
          (Math.max(0, index) + (locator.locations.progression || 0)) /
            Math.max(1, this.publication!.readingOrder.items.length);
        this.events.location(this.location, percent);
      },
      timelineItemChanged: () => {},
      // Consume edge taps: a click clears a selection or opens a note, and
      // never turns a page by accident. Pages turn by key, wheel or swipe.
      tap: () => true,
      click: () => true,
      zoom: () => {},
      miscPointer: () => {},
      scroll: this.clearSelection,
      customEvent: () => {},
      handleLocator: (locator) => /^[a-z]+:/i.test(locator.href),
      textSelected: (selection) => {
        if (this.disposed) return;
        if (!selection.text.trim()) return this.clearState();
        // Readium navigates via contentWindow.location.replace(), so iframe.src
        // does not identify the loaded chapter. Match the active frame manager.
        const frame = this.navigator?._cframes.find(
          (manager) => manager?.source === selection.targetFrameSrc,
        )?.iframe;
        if (!frame) return; // Ignore delayed selections from previous chapters.
        const selected = frame?.contentWindow?.getSelection();
        if (
          !selected ||
          selected.isCollapsed ||
          selected.toString().trim().replace(/\s+/g, " ") !==
            selection.text.trim().replace(/\s+/g, " ")
        )
          return this.clearState();
        const exact =
          selection.locator && selected?.rangeCount
            ? selectionLocator(selection.locator, selected.getRangeAt(0))
            : undefined;
        // A quote alone cannot identify repeated passages. Only expose selections
        // once their exact DOM range has been captured in the Readium locator.
        if (!exact) return this.clearState();
        const location = this.fromLocator(exact);
        this.selectedWindow = frame?.contentWindow ?? undefined;
        this.selection = {
          context: selectionContext(
            selected.getRangeAt(0),
            frame.contentDocument!.body,
          ),
          text: selection.text,
          location,
          anchor: selectionAnchor(
            selected,
            this.selectedWindow
              ? this.pointers.get(this.selectedWindow)
              : undefined,
            frame,
          ),
        };
        this.events.selection(this.selection);
      },
      contentProtection: () => {},
      contextMenu: () => {},
      peripheral: () => {},
    };
    let initial =
      doc.progress?.type === "epub" ? this.toLocator(doc.progress) : undefined;
    if (
      doc.progress?.type === "epub" &&
      initial?.locations.otherLocations?.has("sourceSlice")
    ) {
      try {
        initial = await this.exactLocator(doc.progress);
      } catch {
        /* Reopen the original paragraph if only the saved sentence slice is stale. */
      }
    }
    this.navigator = new EpubNavigator(
      this.container,
      this.publication,
      listeners,
      positions,
      initial,
      {
        preferences: {
          fontSize: 1.15,
          lineHeight: 1.8,
          columnCount: 1,
          scroll: !this.paginated,
        },
        defaults: {},
      },
    );
    this.navigator.registerDecorationObserver(
      "annotations",
      this.annotationObserver,
    );
    this.fadeChapterChanges();
    const loaded = await this.navigator.load();
    if (!this.disposed && !loaded)
      throw new Error("EPUB 正文加载失败，请重新打开这本书");
    this.loaded = true;
  }
  // Every chapter change, including Readium's own swipe and boundary
  // handling, replaces the visible frame through the frame pool.
  private fadeChapterChanges() {
    const pool = (
      this.navigator as unknown as {
        framePool?: { update?: (...args: unknown[]) => Promise<void> };
      }
    ).framePool;
    if (typeof pool?.update !== "function") return;
    const update = pool.update.bind(pool);
    pool.update = (...args: unknown[]) => {
      const target = (args[1] as Locator | undefined)?.href.split("#")[0];
      const source = this.location.href.split("#")[0];
      if (!this.loaded || !target || !source || target === source)
        return update(...args);
      const order = this.publication!.readingOrder.items.map(
        (l) => l.href.split("#")[0],
      );
      const direction = Math.sign(
        order.indexOf(target) - order.indexOf(source),
      );
      return this.transition.run(direction, this.paginated ? "x" : "y", () =>
        update(...args),
      );
    };
  }
  async getTOC(): Promise<TOCItem[]> {
    const map = (items: Link[], prefix = ""): TOCItem[] =>
      items.map((link, i) => ({
        id: `${prefix}${i}`,
        label: link.title || `章节 ${i + 1}`,
        location: { type: "epub", href: link.href },
        children: map(link.children?.items || [], `${prefix}${i}-`),
      }));
    return map(
      this.publication?.toc?.items.length
        ? this.publication.toc.items
        : this.publication?.readingOrder.items || [],
    );
  }
  getLocation() {
    return this.location;
  }
  async goTo(location: DocumentLocation) {
    if (location.type !== "epub" || !this.navigator) return;
    this.clearSelection();
    const locator = await this.exactLocator(location);
    if (this.disposed) return;
    await this.navigate(locator);
  }
  private step(direction: 1 | -1) {
    const move = () =>
      new Promise<void>((resolve) =>
        direction > 0
          ? this.navigator?.goForward(false, () => resolve())
          : this.navigator?.goBackward(false, () => resolve()),
      );
    // Scrolling moves continuously; only page turns need the cross-fade.
    return this.paginated ? this.transition.run(direction, "x", move) : move();
  }
  async next() {
    this.clearSelection();
    await this.step(1);
  }
  async previous() {
    this.clearSelection();
    await this.step(-1);
  }
  async search(query: string): Promise<SearchResult[]> {
    if (!this.doc || !query.trim()) return [];
    const chapters = await api.search(this.doc.id, query);
    const results: SearchResult[] = [];
    for (const chapter of chapters) {
      if (this.disposed || results.length >= 100) break;
      if (chapter.location.type !== "epub") continue;
      const doc = await this.resourceDocument(chapter.location.href);
      const matches = searchEPUBLocators(
        doc,
        this.toLocator(chapter.location),
        query,
        100 - results.length,
      );
      for (const [index, locator] of matches.entries()) {
        results.push({
          id: `${chapter.id}:${index}`,
          excerpt: `${locator.text?.before ?? ""}${locator.text?.highlight ?? ""}${locator.text?.after ?? ""}`,
          location: this.fromLocator(locator),
        });
      }
    }
    return results;
  }
  getSelection() {
    return this.selection;
  }
  async focusEPUBLocations(locations: EPUBLocation[]) {
    const revision = ++this.focusRevision;
    const decorations = await Promise.all(
      locations.map(async (location, index): Promise<Decoration> => ({
        id: `translation-focus-${index}`,
        locator: await this.exactLocator(location),
        style: {
          type: "template",
          layout: DecorationLayout.Boxes,
          width: DecorationWidth.Wrap,
          element: () =>
            '<div style="background:rgba(59,130,246,0.18);border-radius:2px;pointer-events:none;"></div>',
        },
      })),
    );
    if (!this.disposed && revision === this.focusRevision)
      this.navigator?.applyDecorations(decorations, "translation-focus");
  }
  async highlight(annotations: Annotation[]) {
    const revision = ++this.highlightRevision;
    this.annotations = annotations;
    this.clearAnnotationHover();
    const unresolved: string[] = [];
    const decorationAnnotations = new Map<string, string>();
    const decorations = await Promise.all(
      annotations
        .filter(
          (a) =>
            a.location.type === "epub" &&
            !a.location.translation &&
            a.kind !== "bookmark" &&
            a.quote,
        )
        .map((a) => ({ ...a, decorationId: a.id }))
        .map(async (a): Promise<Decoration | undefined> => {
          try {
            const location = a.location as EPUBLocation;
            const locator = await this.exactLocator({
              ...location,
              quote: location.quote || a.quote,
            });
            decorationAnnotations.set(a.decorationId, a.id);
            return {
              id: a.decorationId,
              locator,
              style: {
                type: a.kind === "underline" ? "underline" : "highlight",
                tint: a.color || "#facc15",
              },
            };
          } catch {
            unresolved.push(a.id);
            return undefined;
          }
        }),
    );
    if (this.disposed || revision !== this.highlightRevision) return;
    this.decorationAnnotations = decorationAnnotations;
    this.navigator?.applyDecorations(
      decorations.filter((d): d is Decoration => !!d),
      "annotations",
    );
    const key = unresolved.sort().join(",");
    if (key !== this.unresolvedAnnotations) {
      this.unresolvedAnnotations = key;
      if (unresolved.length)
        throw new Error(
          `${unresolved.length} 条批注暂时无法定位，已保留在笔记中。`,
        );
    }
  }
  async setTheme(theme: ReaderTheme) {
    this.clearSelection();
    const paginated = theme.epubFlow === "paginated";
    const flowChanged = paginated !== this.paginated;
    this.paginated = paginated;
    const palette = {
      light: ["#ffffff", "#27272a"],
      sepia: ["#f7f6f2", "#1f1e1d"],
      // Graphite, or the neutral dark page for pure black.
      dark:
        theme.pdfDarkContrast === "high"
          ? ["#202020", "#dededb"]
          : ["#2f2c2f", "#e4dfda"],
    }[theme.mode];
    const submit = async () => {
      await this.navigator?.submitPreferences(
        new EpubPreferences({
          fontSize: theme.fontSize,
          fontFamily: theme.fontFamily,
          lineHeight: theme.lineHeight,
          pageGutter: theme.margin,
          scrollPaddingLeft: theme.margin,
          scrollPaddingRight: theme.margin,
          scroll: !paginated,
          backgroundColor: palette[0],
          textColor: palette[1],
          columnCount: 1,
        }),
      );
    };
    // Switching between pages and scrolling relayouts the whole chapter.
    await (flowChanged && this.loaded
      ? this.transition.run(0, "x", submit)
      : submit());
  }
  async getContext() {
    if (!this.doc || !this.location.href) return "";
    const href = this.location.href.split("#")[0];
    const response = await fetch(publicationURL(this.doc.id, href));
    if (!response.ok) throw new Error("无法读取章节");
    const html = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    html.querySelectorAll("style,script").forEach((el) => el.remove());
    return (html.body.textContent?.trim() || "").slice(0, 24000);
  }
  async destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resourceDocuments.clear();
    this.highlightRevision++;
    cancelAnimationFrame(this.readingFrame);
    this.resize.disconnect();
    document.removeEventListener("pointerdown", this.onOutsidePointer);
    document.removeEventListener("keydown", this.onKeyDown);
    for (const cleanup of this.frameCleanups.values()) cleanup();
    this.frameCleanups.clear();
    this.clearSelection();
    this.navigator?.unregisterDecorationObserver(this.annotationObserver);
    await this.navigator?.destroy();
    this.container.replaceChildren();
  }
}
