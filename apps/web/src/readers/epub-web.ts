import { selectionContext } from "./selection-context";
import {
  annotationsInRects,
  sentenceRectsAtPoint,
} from "../translation/annotation-hover";
import { api } from "@neoread/api";
import type {
  Annotation,
  Document,
  DocumentLocation,
  EPUBChapter,
  EPUBChapterLink,
  EPUBLocation,
  EPUBReadingBlock,
  ReaderAdapter,
  ReaderEvents,
  ReaderSelection,
  ReaderTheme,
  SearchResult,
  TOCItem,
} from "@neoread/core";
import { toast } from "sonner";
import { openExternalLink } from "../reading-links";
import { defaultTheme } from "@neoread/core";
import { isSelectionToolbar, selectionAnchor } from "./selection-anchor";
import { sentenceBounds } from "./sentence-selection";
import {
  blockOffset,
  blockRange,
  resolveEPUBLocation,
} from "./epub-web-location";
import { EPUBBlockOverlay } from "./epub-block-focus";
import "./epub-web.css";

let sequence = 0;
type Chapter = {
  info: EPUBChapter;
  weight: number;
  node: HTMLElement;
  loaded: boolean;
  pending?: Promise<void>;
};

export class EPUBReaderAdapter implements ReaderAdapter {
  private doc?: Document;
  private chapters: Chapter[] = [];
  private toc: EPUBChapterLink[] = [];
  private blocks: EPUBReadingBlock[] = [];
  private location: EPUBLocation = { type: "epub", href: "" };
  private theme = defaultTheme;
  private selection: ReaderSelection | null = null;
  private annotations: Annotation[] = [];
  private marks: { id: string; range: Range }[] = [];
  private focus: EPUBLocation[] = [];
  private names: string[] = [];
  private prefix = `epub-web-${++sequence}`;
  private style = document.createElement("style");
  private abort = new AbortController();
  private observer?: IntersectionObserver;
  private resize?: ResizeObserver;
  private frame = 0;
  private navigation = 0;
  private restoring = false;
  private anchor?: { node: HTMLElement; top: number; range?: Range };
  private unresolved = "";
  private disposed = false;
  private opening = true;
  private interacted = false;
  private selecting = false;
  private blockOverlay: EPUBBlockOverlay;

  constructor(
    private container: HTMLElement,
    private events: ReaderEvents,
  ) {
    container.classList.add("epub-web-reader");
    container.tabIndex = 0;
    container.setAttribute("aria-label", "EPUB 正文");
    document.head.append(this.style);
    this.blockOverlay = new EPUBBlockOverlay(
      container,
      (id) => this.events.epubBlockHover?.(id),
      (id) => {
        if (this.events.epubBlockFocus) this.events.epubBlockFocus(id);
        else void this.focusBlock(id);
      },
      () => this.blocks,
      (block, action) => this.events.epubBlockAction?.(block, action),
    );
    const signal = this.abort.signal;
    container.addEventListener("scroll", this.onScroll, {
      passive: true,
      signal,
    });
    for (const name of ["wheel", "pointerdown", "keydown"])
      container.addEventListener(
        name,
        () => {
          if (name === "pointerdown") this.selecting = true;
          if (name === "wheel") this.clearSelection();
          this.interacted = true;
          this.events.epubInteraction?.();
        },
        {
          passive: true,
          signal,
        },
      );
    document.addEventListener(
      "pointerup",
      () => {
        this.selecting = false;
      },
      { signal },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        this.selecting = false;
      },
      { signal },
    );
    container.addEventListener(
      "pointerup",
      (event) => this.capture({ x: event.clientX, y: event.clientY }),
      { signal },
    );
    container.addEventListener("keyup", () => this.capture(), { signal });
    container.addEventListener(
      "dblclick",
      () => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const current = selection.getRangeAt(0);
        const element =
          current.startContainer instanceof Element
            ? current.startContainer
            : current.startContainer.parentElement;
        const id =
          element?.closest<HTMLElement>("[data-epub-run]")?.dataset.epubRun ??
          element?.closest<HTMLElement>("[data-epub-block]")?.dataset.epubBlock;
        const block = this.blocks.find((b) => b.id === id);
        if (!block) return;
        const bounds = sentenceBounds(
          block.text,
          blockOffset(
            container,
            block,
            current.startContainer,
            current.startOffset,
          ),
        );
        const range = bounds && blockRange(container, { block, ...bounds });
        if (range) {
          selection.removeAllRanges();
          selection.addRange(range);
          this.capture();
        }
      },
      { signal },
    );
    container.addEventListener("click", this.click, { signal });
    container.addEventListener("pointermove", this.hoverAnnotation, { signal });
    for (const name of ["pointerleave", "pointerdown", "scroll"])
      container.addEventListener(
        name,
        () => this.events.annotationHover?.(null),
        { signal },
      );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (
          !container.contains(event.target as Node) &&
          !isSelectionToolbar(event.target)
        )
          this.clearSelection();
      },
      { signal },
    );
    document.addEventListener(
      "selectionchange",
      () => {
        if (this.selection && !window.getSelection()?.toString()) {
          this.selection = null;
          this.events.selection(null);
        }
      },
      { signal },
    );
    container.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") this.clearSelection();
      },
      { signal },
    );
  }
  preferTheme(theme: ReaderTheme) {
    this.theme = theme;
    this.applyTheme();
  }
  async open(doc: Document) {
    this.doc = doc;
    const listing = await api.epubChapters(doc.id, this.abort.signal);
    if (this.disposed) return;
    this.toc = listing.toc ?? [];
    this.blocks = [];
    this.chapters = listing.chapters.map((info) => {
      const node = document.createElement("section");
      node.className = "epub-web-chapter";
      node.dataset.chapter = info.href;
      node.setAttribute("aria-label", info.title || `第 ${info.index + 1} 章`);
      node.style.height = `${this.estimate(info)}px`;
      node.setAttribute("aria-busy", "true");
      this.container.append(node);
      return {
        info: { ...info },
        weight: Math.max(1, info.characters),
        node,
        loaded: false,
      };
    });
    if (!this.chapters.length) throw new Error("这本 EPUB 没有可阅读的章节");
    const initial =
      doc.progress?.type === "epub"
        ? doc.progress
        : { type: "epub" as const, href: this.chapters[0].info.href };
    try {
      await this.goTo(initial);
    } catch (error) {
      toast.error((error as Error).message);
      await this.goTo({
        type: "epub",
        href:
          this.chapter(initial.href)?.info.href ?? this.chapters[0].info.href,
        progression: initial.progression,
      });
    }
    if (this.disposed) return;
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (!this.container.clientHeight || !this.container.clientWidth)
            return;
          for (const entry of entries)
            if (entry.isIntersecting) {
              const chapter = this.chapters.find(
                (c) => c.node === entry.target,
              );
              if (chapter)
                void this.load(chapter).catch((e) => toast.error(e.message));
            }
        },
        { root: this.container, rootMargin: "1200px 0px" },
      );
      for (const chapter of this.chapters) this.observer.observe(chapter.node);
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => {
        if (this.container.closest("[inert]")) return;
        this.preserveAnchor();
        this.onScroll();
      });
      for (const chapter of this.chapters) this.resize.observe(chapter.node);
      this.resize.observe(this.container);
    }
    this.report();
    this.opening = false;
  }
  private estimate(info: EPUBChapter) {
    const width = Math.max(
      240,
      Math.min(864, this.container.clientWidth) - this.theme.margin * 2,
    );
    const font = this.theme.fontSize * 16;
    return Math.max(
      180,
      ((info.characters * font * 0.55) / width) * font * this.theme.lineHeight +
        info.blocks.length * font +
        info.blocks.filter((b) => b.image).length * 280 +
        48,
    );
  }
  private chapter(href: string) {
    const normalize = (value: string) => {
      try {
        return decodeURIComponent(value.split("#")[0]);
      } catch {
        return value.split("#")[0];
      }
    };
    return this.chapters.find(
      (c) => normalize(c.info.href) === normalize(href),
    );
  }
  private async load(chapter: Chapter) {
    if (chapter.loaded || this.disposed) return;
    if (chapter.pending) return chapter.pending;
    chapter.pending = (async () => {
      const { html, blocks } = await api.epubChapter(
        this.doc!.id,
        chapter.info.href,
        this.abort.signal,
      );
      if (this.disposed) return;
      if (blocks) {
        chapter.info.blocks = blocks;
        chapter.info.characters = blocks.reduce((n, b) => n + b.text.length, 0);
      }
      // Only the authenticated sanitizer endpoint supplies this inert template.
      const template = document.createElement("template");
      template.innerHTML = html;
      for (const element of template.content.querySelectorAll<HTMLElement>(
        "[id]",
      )) {
        element.dataset.epubFragment = element.id;
        element.removeAttribute("id");
      }
      for (const image of template.content.querySelectorAll("img")) {
        image.decoding = "async";
        image.addEventListener("load", () => this.preserveAnchor(), {
          signal: this.abort.signal,
        });
      }
      this.rememberAnchor();
      chapter.node.replaceChildren(template.content);
      chapter.node.style.height = "";
      chapter.node.removeAttribute("aria-busy");
      chapter.loaded = true;
      this.refreshBlocks();
      this.preserveAnchor();
      this.rememberAnchor();
      this.paint();
      if (!this.restoring && !this.opening && this.interacted) this.report();
    })().finally(() => {
      chapter.pending = undefined;
    });
    return chapter.pending;
  }
  private unload(chapter: Chapter) {
    chapter.node.style.height = `${chapter.node.getBoundingClientRect().height || this.estimate(chapter.info)}px`;
    chapter.node.replaceChildren();
    chapter.loaded = false;
    chapter.info.blocks = [];
    this.refreshBlocks();
    this.paint();
  }
  private refreshBlocks() {
    this.blocks = this.chapters
      .filter((c) => c.loaded)
      .flatMap((c) => c.info.blocks);
    this.events.epubBlocksChanged?.(this.blocks);
  }
  getEPUBChapters() {
    return this.chapters.map((c) => ({
      ...c.info,
      characters: c.weight,
      blocks: [],
    }));
  }
  private rememberAnchor() {
    if (this.restoring || !this.container.clientHeight) return;
    const top = this.container.getBoundingClientRect().top;
    const nodes = Array.from(
      this.container.querySelectorAll<HTMLElement>("[data-epub-block]"),
    );
    const node =
      nodes.find((n) => {
        const rect = n.getBoundingClientRect();
        return (
          rect.bottom > top && rect.top < top + this.container.clientHeight
        );
      }) ??
      this.chapters.find((c) => c.node.getBoundingClientRect().bottom > top)
        ?.node;
    if (!node) {
      this.anchor = undefined;
      return;
    }
    const block = this.blocks.find((b) => b.id === node.dataset.epubBlock);
    // Keep the actual visible character stable when a long paragraph reflows.
    // Its element top alone does not describe the reader's place inside it.
    const offset = block && this.visibleOffset(block, top);
    const range =
      block && offset !== undefined && offset < block.text.length
        ? blockRange(this.container, { block, start: offset, end: offset + 1 })
        : undefined;
    const textRect = range?.getClientRects()[0];
    this.anchor = {
      node,
      top: textRect?.top ?? node.getBoundingClientRect().top,
      ...(textRect ? { range } : {}),
    };
  }
  private preserveAnchor() {
    if (
      this.restoring ||
      !this.container.clientHeight ||
      !this.anchor?.node.isConnected
    )
      return;
    const delta =
      (this.anchor.range?.getClientRects()[0]?.top ??
        this.anchor.node.getBoundingClientRect().top) - this.anchor.top;
    if (Math.abs(delta) > 0.5) this.container.scrollTop += delta;
  }
  private onScroll = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (
        this.disposed ||
        this.restoring ||
        !this.container.clientHeight ||
        !this.container.clientWidth
      )
        return;
      this.rememberAnchor();
      if (this.interacted) this.report();
      // Keep distant chapters as measured placeholders. Selection/focus chapters
      // stay mounted so DOM ranges cannot disappear while the toolbar is open.
      const top = this.container.getBoundingClientRect().top,
        height = this.container.clientHeight;
      for (const chapter of this.chapters) {
        const rect = chapter.node.getBoundingClientRect();
        if (rect.bottom > top - 1200 && rect.top < top + height + 1200)
          void this.load(chapter).catch((e) => toast.error(e.message));
        else if (
          chapter.loaded &&
          !this.selection &&
          !this.selecting &&
          !this.focus.length &&
          (rect.bottom < top - 5000 || rect.top > top + height + 5000)
        ) {
          this.unload(chapter);
        }
      }
    });
  };
  private report() {
    if (!this.container.clientHeight) return;
    const top =
      this.container.getBoundingClientRect().top +
      this.container.clientHeight * 0.25;
    const atEnd =
      this.container.scrollHeight > this.container.clientHeight &&
      this.container.scrollTop + this.container.clientHeight >=
        this.container.scrollHeight - 2;
    const chapter = atEnd
      ? this.chapters.at(-1)
      : (this.chapters.find(
          (c) => c.node.getBoundingClientRect().bottom > top,
        ) ?? this.chapters.at(-1));
    if (!chapter?.loaded) return;
    const elements = Array.from(
      chapter.node.querySelectorAll<HTMLElement>("[data-epub-block]"),
    );
    const element = atEnd
      ? elements.at(-1)
      : elements.find((n) => n.getBoundingClientRect().bottom > top);
    const block = chapter.info.blocks.find(
      (b) => b.id === element?.dataset.epubBlock,
    );
    const before = chapter.info.blocks
      .slice(0, block ? chapter.info.blocks.indexOf(block) : 0)
      .reduce((n, b) => n + b.text.length, 0);
    const rect = chapter.node.getBoundingClientRect();
    const offset = block
      ? atEnd
        ? block.text.length
        : this.visibleOffset(block, top)
      : 0;
    const progression = atEnd
      ? 1
      : block
        ? (before + offset) / Math.max(1, chapter.info.characters)
        : Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height)));
    this.location = {
      type: "epub",
      href: chapter.info.href,
      progression,
      ...(block ? { blockId: block.id, start: offset, end: offset } : {}),
    };
    this.emitLocation();
    if (block) this.events.epubReadingAnchor?.(block.id);
  }
  private visibleOffset(block: EPUBReadingBlock, top: number) {
    let start = 0,
      end = block.text.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      const range = blockRange(this.container, {
        block,
        start: middle,
        end: middle + 1,
      });
      if (!range) return 0;
      if (range.getBoundingClientRect().bottom <= top) start = middle + 1;
      else end = middle;
    }
    return start;
  }
  private emitLocation() {
    if (this.opening) return;
    const chapter = this.chapter(this.location.href);
    const preceding = this.chapters
      .slice(0, chapter ? this.chapters.indexOf(chapter) : 0)
      .reduce((n, c) => n + c.weight, 0);
    const total = this.chapters.reduce((n, c) => n + c.weight, 0);
    this.events.location(
      this.location,
      Math.min(
        1,
        (preceding +
          (this.location.progression ?? 0) * (chapter?.weight ?? 1)) /
          Math.max(1, total),
      ),
    );
  }
  async getTOC(): Promise<TOCItem[]> {
    const map = (links: EPUBChapterLink[], prefix = ""): TOCItem[] =>
      links.map((link, i) => ({
        id: `${prefix}${i}`,
        label: link.title || `第 ${i + 1} 章`,
        location: { type: "epub", href: link.href },
        children: map(link.children ?? [], `${prefix}${i}-`),
      }));
    return map(this.toc.length ? this.toc : this.chapters.map((c) => c.info));
  }
  getLocation() {
    return this.location;
  }
  async goTo(location: DocumentLocation) {
    if (location.type !== "epub" || this.disposed) return;
    const chapter = this.chapter(location.href);
    if (!chapter) throw new Error("该章节不属于当前书籍");
    const revision = ++this.navigation;
    this.clearSelection();
    this.restoring = true;
    try {
      await this.load(chapter);
      if (this.disposed || revision !== this.navigation) return;
      const canonical = { ...location, href: chapter.info.href };
      if (location.endBlockId && location.endBlockId !== location.blockId) {
        const start = this.chapters.indexOf(chapter);
        const endHref =
          location.endHref ??
          this.blocks.find((b) => b.id === location.endBlockId)?.location.href;
        let end = endHref
          ? this.chapters.findIndex((c) => c.info.href === endHref)
          : -1;
        // Older cross-chapter notes have only the end block ID. Look it up on
        // explicit navigation, discarding each candidate response immediately.
        if (!endHref)
          for (let i = start + 1; i < this.chapters.length; i++) {
            const candidate = this.chapters[i];
            const blocks = candidate.loaded
              ? candidate.info.blocks
              : ((
                  await api.epubChapter(
                    this.doc!.id,
                    candidate.info.href,
                    this.abort.signal,
                  )
                ).blocks ?? candidate.info.blocks);
            if (this.disposed || revision !== this.navigation) return;
            if (blocks.some((b) => b.id === location.endBlockId)) {
              end = i;
              break;
            }
          }
        if (end >= start)
          for (const part of this.chapters.slice(start + 1, end + 1)) {
            await this.load(part);
            if (this.disposed || revision !== this.navigation) return;
          }
      }
      const slices = resolveEPUBLocation(canonical, this.blocks);
      for (const href of new Set(
        slices.map((slice) => slice.block.location.href),
      )) {
        const part = this.chapter(href);
        if (part && part !== chapter) await this.load(part);
      }
      if (this.disposed || revision !== this.navigation) return;
      const range = slices[0] && blockRange(this.container, slices[0]);
      let legacy: {
        locations?: {
          fragments?: string[];
          progression?: number;
          domRange?: unknown;
          textRange?: unknown;
        };
        text?: { highlight?: string };
      } = {};
      try {
        const parsed = JSON.parse(location.locator || "{}");
        if (parsed && typeof parsed === "object") legacy = parsed;
      } catch {
        /* Fall back to a saved quote. */
      }
      const progression = location.progression ?? legacy.locations?.progression;
      let target: HTMLElement | undefined;
      const fragment =
        location.href.split("#").slice(1).join("#") ||
        legacy.locations?.fragments?.[0];
      if (fragment) {
        let decoded = fragment;
        try {
          decoded = decodeURIComponent(fragment);
        } catch {
          /* Keep literal malformed fragments. */
        }
        target = Array.from(
          chapter.node.querySelectorAll<HTMLElement>("[data-epub-fragment]"),
        ).find((n) => n.dataset.epubFragment === decoded);
      }
      if (
        !slices.length &&
        (location.blockId ||
          location.quote ||
          legacy.text?.highlight ||
          legacy.locations?.domRange ||
          legacy.locations?.textRange)
      )
        throw new Error("未能唯一定位这段原文，笔记已保留。请使用书内搜索。");
      if (fragment && !target) throw new Error("未能定位此目录条目");
      const fragmentNode =
        target &&
        (target.closest<HTMLElement>("[data-epub-block]") ??
          Array.from(
            chapter.node.querySelectorAll<HTMLElement>("[data-epub-block]"),
          ).find(
            (node) =>
              target.contains(node) ||
              !!(
                target.compareDocumentPosition(node) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ),
          ));
      const fragmentBlock =
        fragmentNode &&
        chapter.info.blocks.find(
          (block) => block.id === fragmentNode.dataset.epubBlock,
        );
      const element = slices[0] && this.blockElement(slices[0].block.id);
      const top =
        range && range.getClientRects().length
          ? range.getBoundingClientRect().top
          : (target ?? element ?? chapter.node).getBoundingClientRect().top;
      this.container.scrollTop +=
        top -
        this.container.getBoundingClientRect().top -
        this.container.clientHeight * 0.25;
      if (!slices.length && !target && progression)
        this.container.scrollTop +=
          chapter.node.getBoundingClientRect().height * progression;
      this.location = {
        ...canonical,
        ...(fragmentBlock
          ? {
              blockId: fragmentBlock.id,
              start: 0,
              end: Math.min(1, fragmentBlock.text.length),
            }
          : {}),
        progression:
          progression ??
          (slices[0]
            ? chapter.info.blocks
                .slice(0, chapter.info.blocks.indexOf(slices[0].block))
                .reduce((n, b) => n + b.text.length, 0) /
              Math.max(1, chapter.info.characters)
            : 0),
      };
      // Search results and source notes use native selection; sync locations only
      // focus/scroll and must not open a toolbar over translated selections.
      if (
        range &&
        location.quote &&
        !location.translation &&
        !location.locator &&
        !this.opening
      ) {
        const last = slices.at(-1)!;
        const end = blockRange(this.container, last);
        if (end) range.setEnd(end.endContainer, end.endOffset);
        const selected = window.getSelection();
        selected?.removeAllRanges();
        selected?.addRange(range);
        this.capture();
      }
      // Translation-only mode has no source viewport to drive the observers.
      if (!this.container.clientHeight && !this.opening) {
        const index = this.chapters.indexOf(chapter);
        for (const neighbor of this.chapters.slice(
          Math.max(0, index - 1),
          index + 2,
        )) {
          await this.load(neighbor);
          if (this.disposed || revision !== this.navigation) return;
        }
        if (!this.selection && !this.focus.length)
          for (const other of this.chapters) {
            if (
              other.loaded &&
              Math.abs(this.chapters.indexOf(other) - index) > 1
            )
              this.unload(other);
          }
      }
      this.emitLocation();
      if (slices[0]) this.events.epubReadingAnchor?.(slices[0].block.id);
    } finally {
      if (revision === this.navigation) {
        this.restoring = false;
        this.rememberAnchor();
      }
    }
  }
  private blockElement(id: string) {
    return Array.from(
      this.container.querySelectorAll<HTMLElement>("[data-epub-block]"),
    ).find((n) => n.dataset.epubBlock === id);
  }
  async next() {
    this.container.scrollTop += this.container.clientHeight * 0.85;
    this.onScroll();
  }
  async previous() {
    this.container.scrollTop -= this.container.clientHeight * 0.85;
    this.onScroll();
  }
  async search(query: string): Promise<SearchResult[]> {
    if (!this.doc || !query.trim()) return [];
    const hits = await api.search(this.doc.id, query);
    const hrefs = new Set(
      hits.flatMap((hit) =>
        hit.location.type === "epub" ? [hit.location.href.split("#")[0]] : [],
      ),
    );
    const results: SearchResult[] = [];
    const escaped = query
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    for (const chapter of this.chapters) {
      if (!hrefs.has(chapter.info.href)) continue;
      const blocks = chapter.loaded
        ? chapter.info.blocks
        : ((
            await api.epubChapter(
              this.doc.id,
              chapter.info.href,
              this.abort.signal,
            )
          ).blocks ?? chapter.info.blocks);
      let text = "";
      const spans = blocks
        .filter((block) => !block.image)
        .map((block) => {
          if (text) text += "\n\n";
          const start = text.length;
          text += block.text;
          return { block, start, end: text.length };
        });
      for (const match of text.matchAll(new RegExp(escaped, "giu"))) {
        const start = match.index,
          end = start + match[0].length;
        const first = spans.find((span) => span.end > start),
          last = spans.find((span) => span.end >= end);
        if (!first || !last) continue;
        results.push({
          id: `${first.block.id}:${start - first.start}`,
          excerpt: text.slice(Math.max(0, start - 35), end + 60),
          location: {
            type: "epub",
            href: chapter.info.href,
            blockId: first.block.id,
            start: start - first.start,
            end: end - last.start,
            quote: match[0],
            ...(first !== last ? { endBlockId: last.block.id } : {}),
          },
        });
        if (results.length >= 100) return results;
      }
    }
    return results;
  }
  private capture(pointer?: { x: number; y: number }) {
    const selected = window.getSelection();
    if (
      !selected?.rangeCount ||
      selected.isCollapsed ||
      !selected.toString().trim()
    )
      return;
    const range = selected.getRangeAt(0);
    if (
      !this.container.contains(range.startContainer) ||
      !this.container.contains(range.endContainer)
    )
      return;
    const chapter = this.chapters.find((c) =>
      c.node.contains(range.startContainer),
    );
    if (!chapter) return;
    // Only chapters the selection touches can contain its blocks.
    const candidates = this.chapters
      .filter((c) => c.loaded && range.intersectsNode(c.node))
      .flatMap((c) => c.info.blocks);
    const matches = candidates.filter((block) => {
      const r = blockRange(this.container, {
        block,
        start: 0,
        end: block.text.length,
      });
      return (
        r &&
        range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, r) > 0
      );
    });
    const first = matches[0],
      last = matches.at(-1);
    if (!first || !last) return;
    const location: EPUBLocation = {
      type: "epub",
      href: chapter.info.href,
      blockId: first.id,
      start: blockOffset(
        this.container,
        first,
        range.startContainer,
        range.startOffset,
      ),
      end: blockOffset(
        this.container,
        last,
        range.endContainer,
        range.endOffset,
      ),
      quote: selected.toString(),
      progression:
        (chapter.info.blocks
          .slice(0, chapter.info.blocks.indexOf(first))
          .reduce((n, b) => n + b.text.length, 0) +
          blockOffset(
            this.container,
            first,
            range.startContainer,
            range.startOffset,
          )) /
        Math.max(1, chapter.info.characters),
      ...(last.id !== first.id ? { endBlockId: last.id } : {}),
      ...(last.location.href !== first.location.href
        ? { endHref: last.location.href }
        : {}),
    };
    this.selection = {
      context: selectionContext(range, this.container),
      text: selected.toString(),
      location,
      anchor: selectionAnchor(selected, pointer),
    };
    this.events.selection(this.selection);
  }
  getSelection() {
    return this.selection;
  }
  clearSelection = () => {
    if (this.selection) {
      const selected = window.getSelection();
      if (selected?.anchorNode && this.container.contains(selected.anchorNode))
        selected.removeAllRanges();
    }
    this.selection = null;
    this.events.selection(null);
  };
  private hoverAnnotation = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      !target ||
      event.buttons ||
      window.getSelection()?.toString().trim() ||
      target.closest("a,button,input,textarea")
    ) {
      this.events.annotationHover?.(null);
      return;
    }
    const rects = sentenceRectsAtPoint(target, event.clientX, event.clientY);
    const byId = new Map(this.annotations.map((a) => [a.id, a]));
    const ranges = this.marks.flatMap((mark) => {
      const annotation = byId.get(mark.id);
      return annotation ? [{ annotation, range: mark.range }] : [];
    });
    const matches = annotationsInRects(
      this.container,
      this.annotations,
      ranges,
      rects,
    );
    this.events.annotationHover?.(
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
  };
  private click = (event: MouseEvent) => {
    const link =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (link && this.container.contains(link)) {
      event.preventDefault();
      event.stopPropagation();
      const href = link.getAttribute("href");
      if (!href) return;
      if (/^(https?:|mailto:)/i.test(href)) {
        openExternalLink(href);
        return;
      }
      if (!this.chapter(href)) {
        toast.error("此链接未指向可阅读的章节");
        return;
      }
      this.events.internalLink?.(this.location);
      void this.goTo({ type: "epub", href }).catch((e) =>
        toast.error(e.message),
      );
      return;
    }
    if (window.getSelection()?.toString().trim()) return;
    const hits = this.marks.filter((mark) =>
      Array.from(mark.range.getClientRects()).some(
        (r) =>
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom,
      ),
    );
    this.events.annotation?.(
      hits.length
        ? {
            ids: [...new Set(hits.map((h) => h.id))],
            anchor: {
              x: event.clientX,
              top: event.clientY - 8,
              bottom: event.clientY + 8,
            },
          }
        : null,
    );
    // Marked text opens its annotation; any other click focuses the block.
    if (!hits.length) this.blockOverlay.click(event);
  };
  async highlight(annotations: Annotation[]) {
    this.annotations = annotations;
    this.paint();
  }
  private paint() {
    this.marks = [];
    for (const name of this.names) globalThis.CSS?.highlights?.delete(name);
    this.names = [];
    this.style.textContent = "";
    const rules: string[] = [],
      unresolved: string[] = [];
    const add = (ranges: Range[], color: string, underline = false) => {
      if (
        typeof Highlight === "undefined" ||
        !globalThis.CSS?.highlights ||
        !ranges.length
      )
        return;
      const name = `${this.prefix}-${this.names.length}`;
      CSS.highlights.set(name, new Highlight(...ranges));
      this.names.push(name);
      const tint = /^#[a-f\d]{6}$/i.test(color) ? color : "#facc15";
      rules.push(
        `::highlight(${name}) { ${underline ? `text-decoration: underline ${tint} 2px` : `background-color: ${tint}66; color: inherit`} }`,
      );
    };
    for (const annotation of this.annotations) {
      if (annotation.location.type !== "epub" || annotation.kind === "bookmark")
        continue;
      if (annotation.location.translation) continue;
      const locations = [
        {
          ...annotation.location,
          quote: annotation.location.quote || annotation.quote,
        },
      ];
      const ranges: Range[] = [];
      for (const location of locations) {
        if (!this.chapter(location.href)?.loaded) continue;
        const slices = resolveEPUBLocation(location, this.blocks);
        if (
          !slices.length &&
          (!location.endBlockId ||
            this.blocks.some((b) => b.id === location.endBlockId))
        )
          unresolved.push(annotation.id);
        for (const slice of slices) {
          const range = blockRange(this.container, slice);
          if (range) {
            ranges.push(range);
            this.marks.push({ id: annotation.id, range });
          }
        }
      }
      add(ranges, annotation.color, annotation.kind === "underline");
    }
    add(
      this.focus.flatMap((location) =>
        resolveEPUBLocation(location, this.blocks).flatMap((slice) => {
          const range = blockRange(this.container, slice);
          return range ? [range] : [];
        }),
      ),
      "#3b82f6",
    );
    this.style.textContent = rules.join("\n");
    const key = [...new Set(unresolved)].sort().join(",");
    if (key && key !== this.unresolved)
      toast.error(
        `${new Set(unresolved).size} 条批注暂时无法定位，已保留在笔记中。`,
      );
    this.unresolved = key;
  }
  async focusEPUBLocations(locations: EPUBLocation[]) {
    this.focus = locations;
    for (const location of locations) {
      const chapter = this.chapter(location.href);
      if (chapter) await this.load(chapter);
    }
    if (!this.disposed) this.paint();
  }
  hoverBlock(blockId: string | null) {
    this.blockOverlay.setLinkedBlock(blockId);
  }
  async focusBlock(blockId: string) {
    const block = this.blocks.find((b) => b.id === blockId);
    const chapter = block && this.chapter(block.location.href);
    if (!chapter || this.disposed) return;
    await this.load(chapter);
    if (!this.disposed) await this.blockOverlay.focus(blockId);
  }
  cancelBlockFocus() {
    this.blockOverlay.cancel();
  }
  setEPUBBlocks(_blocks: EPUBReadingBlock[]) {
    /* Sanitized chapter metadata owns the source block order. */
  }
  private applyTheme() {
    const palette = {
      light: ["#ffffff", "#27272a"],
      sepia: ["#f7f6f2", "#1f1e1d"],
      // Graphite, or the neutral dark page for pure black.
      dark:
        this.theme.pdfDarkContrast === "high"
          ? ["#202020", "#dededb"]
          : ["#2f2c2f", "#e4dfda"],
    }[this.theme.mode];
    Object.assign(this.container.style, {
      fontSize: `${this.theme.fontSize}rem`,
      fontFamily: this.theme.fontFamily,
      lineHeight: String(this.theme.lineHeight),
      backgroundColor: palette[0],
      color: palette[1],
    });
    this.container.style.setProperty("--epub-margin", `${this.theme.margin}px`);
  }
  async setTheme(theme: ReaderTheme) {
    this.rememberAnchor();
    this.theme = theme;
    this.applyTheme();
    for (const chapter of this.chapters)
      if (!chapter.loaded)
        chapter.node.style.height = `${this.estimate(chapter.info)}px`;
    this.preserveAnchor();
  }
  async getContext() {
    return (
      this.chapter(this.location.href)
        ?.info.blocks.filter((b) => !b.image)
        .map((b) => b.text)
        .join("\n\n")
        .slice(0, 24000) ?? ""
    );
  }
  async destroy() {
    this.events.annotationHover?.(null);
    this.disposed = true;
    this.navigation++;
    this.blockOverlay.destroy();
    this.abort.abort();
    this.observer?.disconnect();
    this.resize?.disconnect();
    cancelAnimationFrame(this.frame);
    for (const name of this.names) globalThis.CSS?.highlights?.delete(name);
    this.style.remove();
    this.clearSelection();
    this.container.replaceChildren();
  }
}
