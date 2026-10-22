import { PDFFigureLinks } from "./pdf-figure-links";
import { selectionContext } from "./selection-context";
import { selectionAnchor, isSelectionToolbar } from "./selection-anchor";
import { pdfQuotePoint } from "./pdf-reference-location";
import { PDFBlockOverlay, referenceBlock } from "./pdf-blocks";
import { PDFReadingNavigation } from "./pdf-navigation";
import { PDFLocationHighlight } from "./pdf-location-highlight";
import { PDFAnnotationLayer } from "./pdf-annotations";
import { PDFLinkPreview } from "./pdf-link-preview";
import * as pdfjs from "pdfjs-dist";
import {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type {
  Annotation,
  PDFBlock,
  Document,
  DocumentLocation,
  PDFLocation,
  ReaderAdapter,
  ReaderEvents,
  ReaderSelection,
  ReaderTheme,
  SearchResult,
  TOCItem,
} from "@reader/core";
import { publicationURL } from "@reader/api";
import { zoomCommand } from "@reader/core";
import { selectSentence } from "./sentence-selection";
import { installPDFExternalLinks } from "./pdf-external-links";
import { resolvePDFCitation } from "./pdf-citations";
import type { PDFDarkRegion } from "./pdf-dark-mode";
import { pdfDrawColors, type PDFDrawColors } from "./pdf-draw-colors";
import { defaultTheme } from "@reader/core";
pdfjs.GlobalWorkerOptions.workerSrc = workerURL;

export class PDFReaderAdapter implements ReaderAdapter {
  private pdf?: pdfjs.PDFDocumentProxy;
  private task?: pdfjs.PDFDocumentLoadingTask;
  private viewer: PDFViewer;
  private bus = new EventBus();
  private links: PDFLinkService;
  private location: PDFLocation = { type: "pdf", page: 1 };
  private selection: ReaderSelection | null = null;
  private annotationLayer: PDFAnnotationLayer;
  private locationHighlight: PDFLocationHighlight;
  private linkPreview: PDFLinkPreview;
  private removeExternalLinks: () => void;
  private texts = new Map<number, string>();
  private resize: ResizeObserver;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private resolutionQuery?: MediaQueryList;
  private fitWidth = true;
  private appliedZoom?: ReaderTheme["zoom"];
  private wheelScale?: number;
  private wheelAppliedScale?: number;
  private disposed = false;
  private navigationRequest = 0;
  private blocks: PDFBlockOverlay;
  private blockData: PDFBlock[] = [];
  private selecting = false;
  private navigation: PDFReadingNavigation;
  private pointer?: { x: number; y: number };
  private theme: ReaderTheme = defaultTheme;
  private figureLinks: PDFFigureLinks;
  constructor(
    private container: HTMLElement,
    private events: ReaderEvents,
  ) {
    container.classList.add("pdf-container");
    this.removeExternalLinks = installPDFExternalLinks(container);
    this.figureLinks = new PDFFigureLinks(
      container,
      () => this.blockData,
      (block) => {
        this.linkPreview.hide();
        this.events.internalLink?.(this.getLocation());
        if (this.events.blockFocus) this.events.blockFocus(block);
        else void this.focusBlock(block.id, "source");
      },
    );
    this.locationHighlight = new PDFLocationHighlight(container);
    this.annotationLayer = new PDFAnnotationLayer(container, (target) =>
      this.events.annotation?.(target),
    );
    this.linkPreview = new PDFLinkPreview(
      container,
      () => this.pdf,
      (preview) => this.events.linkPreview?.(preview),
      () => this.events.internalLink?.(this.getLocation()),
      () => this.theme,
      (page) => this.figureRegions(page),
      (page) => this.drawColors(page),
    );
    this.blocks = new PDFBlockOverlay(
      container,
      (block, action) => this.events.blockAction?.(block, action),
      (block) => this.events.blockHover?.(block),
      (block) => {
        if (this.events.blockFocus) this.events.blockFocus(block);
        else void this.focusBlock(block.id, "source");
        return true;
      },
    );
    const viewer = document.createElement("div");
    viewer.className = "pdfViewer";
    // Let even the last page's column end reach the viewport midpoint.
    viewer.style.paddingBottom = `${container.clientHeight / 2}px`;
    container.append(viewer);
    this.links = new PDFLinkService({
      eventBus: this.bus,
      externalLinkTarget: 2,
    });
    this.viewer = new PDFViewer({
      container: container as HTMLDivElement,
      viewer,
      eventBus: this.bus,
      linkService: this.links,
      textLayerMode: 1,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      removePageBorders: true,
      // Native device-pixel rendering for ordinary reading. High zoom retains
      // PDF.js detail canvases (including their viewport overscan), with a
      // bounded cache instead of keeping ten full-resolution pages alive.
      maxCanvasPixels: 8 * 1024 * 1024,
      maxCanvasDim: 16384,
      enableOptimizedPartialRendering: true,
      preRenderExtra: true,
      pageCacheSize: 3,
      minDurationToUpdateCanvas: 0,
      getReaderColorAdapter: (page) => this.drawColors(page),
      // Infinity records every image location without enabling an image menu.
      imagesRightClickMinSize: Number.POSITIVE_INFINITY,
    });
    this.links.setViewer(this.viewer);
    this.bus.on("pagesinit", () => {
      // PDFViewer resets lang during setup. Explicitly mark it unknown before
      // text rendering to match PDF.js's measurement canvas and stop inheriting
      // the app's zh-CN font choice. PDF metadata may supply the language later.
      viewer.lang = "";
    });
    this.navigation = new PDFReadingNavigation(
      container,
      this.viewer,
      (n) => this.pdf!.getPage(n),
      () => this.blockData,
      this.events,
      (blockId) => this.blocks.setFocusBlock(blockId),
    );
    this.bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      this.location = { type: "pdf", page: pageNumber };
      this.events.location(
        this.location,
        pageNumber / (this.pdf?.numPages || 1),
      );
    });
    this.bus.on("pagerendered", () => {
      this.paintHighlights();
      this.locationHighlight.paint();
      this.navigation.repaint();
      this.blocks.repaint();
    });
    this.bus.on("textlayerrendered", () => {
      this.navigation.repaint();
      this.figureLinks.repaint();
      this.locationHighlight.paint();
    });
    document.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("pointerdown", this.onPointerDown);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("keydown", this.onKeyDown);
    container.addEventListener("wheel", this.onWheel, { passive: false });
    container.addEventListener("scroll", this.onScroll, {
      passive: true,
    });
    this.resize = new ResizeObserver(() => {
      viewer.style.paddingBottom = `${container.clientHeight / 2}px`;
      this.clearSelection();
      clearTimeout(this.resizeTimer);
      const fit = () => {
        if (container.closest("[inert]")) return;
        if (!this.disposed && this.pdf && this.fitWidth)
          this.viewer.currentScaleValue = "page-width";
      };
      // Refit once the sidebar settles, not on every animation frame.
      if (container.closest("[data-toggling]"))
        this.resizeTimer = setTimeout(fit, 100);
      else fit();
    });
    this.resize.observe(container);
    this.watchResolution();
  }
  private watchResolution = () => {
    this.resolutionQuery?.removeEventListener(
      "change",
      this.onResolutionChange,
    );
    if (typeof window.matchMedia !== "function" || this.disposed) return;
    this.resolutionQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    );
    this.resolutionQuery.addEventListener("change", this.onResolutionChange);
  };
  private onResolutionChange = () => {
    this.watchResolution();
    this.linkPreview.invalidate();
    if (this.pdf && !this.disposed) this.redrawPages();
  };
  preferTheme(theme: ReaderTheme) {
    this.theme = theme;
    this.container.dataset.theme = theme.mode;
    this.container.dataset.darkContrast = theme.pdfDarkContrast ?? "soft";
  }
  async open(doc: Document) {
    this.task = pdfjs.getDocument({
      url: publicationURL(doc.id, "original.pdf"),
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
      // There is no full-page CPU pixel readback in the display path.
      enableHWA: true,
    });
    this.pdf = await this.task.promise;
    if (this.disposed) return;
    const initialized = new Promise<void>((resolve) => {
      const ready = () => {
        this.bus.off("pagesinit", ready);
        resolve();
      };
      this.bus.on("pagesinit", ready);
    });
    this.viewer.setDocument(this.pdf);
    this.links.setDocument(this.pdf);
    await initialized;
    if (this.disposed) return;
    this.viewer.currentScaleValue = "page-width";
    if (doc.progress?.type === "pdf") await this.goTo(doc.progress);
    else this.events.location(this.location, 1 / this.pdf.numPages);
  }
  async getTOC(): Promise<TOCItem[]> {
    if (!this.pdf) return [];
    const outline = await this.pdf.getOutline();
    const map = async (
      items: NonNullable<typeof outline>,
      prefix = "",
    ): Promise<TOCItem[]> =>
      Promise.all(
        items.map(async (item, i) => {
          const children = await map(item.items, `${prefix}${i}-`);
          // A grouping entry without its own target opens its first child.
          const first = children[0]?.location;
          let page = first?.type === "pdf" ? first.page : 1;
          let dest = item.dest;
          try {
            if (typeof dest === "string")
              dest = await this.pdf!.getDestination(dest);
            if (Array.isArray(dest)) {
              page =
                typeof dest[0] === "number"
                  ? dest[0] + 1
                  : (await this.pdf!.getPageIndex(dest[0])) + 1;
            }
          } catch {
            /* broken outline entry keeps a safe page */
          }
          return {
            id: `${prefix}${i}`,
            label: item.title,
            location: { type: "pdf" as const, page },
            children,
          };
        }),
      );
    return outline?.length
      ? map(outline)
      : Array.from({ length: this.pdf.numPages }, (_, i) => ({
          id: `page-${i + 1}`,
          label: `第 ${i + 1} 页`,
          location: { type: "pdf", page: i + 1 },
          children: [],
        }));
  }
  getPageCount() {
    return this.pdf?.numPages ?? 0;
  }
  getLocation(): PDFLocation {
    const page = this.viewer.getPageView(this.location.page - 1)?.div as
      HTMLElement | undefined;
    const bounds = page?.getBoundingClientRect();
    if (!bounds?.height || !bounds.width)
      return { type: "pdf", page: this.location.page };
    const viewport = this.container.getBoundingClientRect();
    return {
      type: "pdf",
      page: this.location.page,
      x: Math.max(0, Math.min(1, (viewport.left - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (viewport.top - bounds.top) / bounds.height)),
    };
  }
  isNear(location: DocumentLocation) {
    if (location.type !== "pdf") return false;
    const page = this.viewer.getPageView(location.page - 1)?.div as
      HTMLElement | undefined;
    const bounds = page?.getBoundingClientRect();
    if (!bounds?.height) return false;
    const view = this.container.getBoundingClientRect();
    const top = bounds.top + (location.y ?? 0) * bounds.height;
    const overlap =
      Math.min(view.bottom, top + view.height) - Math.max(view.top, top);
    return overlap > view.height / 2;
  }
  async goTo(location: DocumentLocation) {
    if (location.type !== "pdf" || !this.pdf) return;
    this.locationHighlight.clear();
    const request = ++this.navigationRequest;
    this.clearSelection();
    const page = Math.max(1, Math.min(this.pdf.numPages, location.page));
    const pdfPage = await this.pdf.getPage(page);
    if (this.disposed || request !== this.navigationRequest) return;
    const viewport = pdfPage.getViewport({ scale: 1 });
    let point =
      location.rects?.[0] ||
      (location.x !== undefined || location.y !== undefined
        ? { x: location.x ?? 0, y: location.y ?? 0 }
        : undefined);
    if (!point && location.quote) {
      const content = await pdfPage.getTextContent();
      point = pdfQuotePoint(
        content.items.filter((item) => "str" in item),
        location.quote,
        viewport,
      );
    }
    if (this.disposed || request !== this.navigationRequest) return;
    const completed = await this.navigation.goTo(page, point);
    if (!completed || this.disposed || request !== this.navigationRequest)
      return;
    this.location = { ...location, page };
    this.events.location(this.location, page / this.pdf.numPages);
  }
  async next() {
    await this.goTo({ type: "pdf", page: this.location.page + 1 });
  }
  async previous() {
    await this.goTo({ type: "pdf", page: this.location.page - 1 });
  }
  private async pageText(page: number) {
    if (!this.texts.has(page) && this.pdf) {
      const p = await this.pdf.getPage(page);
      const content = await p.getTextContent();
      this.texts.set(
        page,
        content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
      );
    }
    return this.texts.get(page) || "";
  }
  async search(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    if (!query.trim() || !this.pdf) return results;
    for (let page = 1; page <= this.pdf.numPages && !this.disposed; page++) {
      const text = await this.pageText(page);
      const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (index >= 0)
        results.push({
          id: `${page}`,
          excerpt: text.slice(
            Math.max(0, index - 65),
            index + query.length + 110,
          ),
          location: { type: "pdf", page, quote: query },
        });
      if (results.length >= 100) break;
    }
    return results;
  }
  private clearState = () => {
    if (!this.selection) return;
    this.selection = null;
    this.events.selection(null);
  };
  clearSelection = () => {
    this.events.annotation?.(null);
    this.annotationLayer.clear();
    const sel = window.getSelection();
    if (sel?.anchorNode && this.container.contains(sel.anchorNode))
      sel.removeAllRanges();
    this.clearState();
  };
  private onScroll = () => {
    this.clearSelection();
  };
  private onPointerDown = (event: PointerEvent) => {
    if (isSelectionToolbar(event.target)) return;
    this.locationHighlight.clear();
    this.events.annotation?.(null);
    this.pointer = undefined;
    this.selecting =
      event.target instanceof Node && this.container.contains(event.target);
    if (this.selecting) this.clearState();
    else this.clearSelection();
  };
  private onKeyDown = (event: KeyboardEvent) => {
    this.selecting = false;
    this.pointer = undefined;
    if (event.key === "Escape") this.clearSelection();
    const command = zoomCommand(event);
    if (!command || event.defaultPrevented || !this.canZoom(event.target))
      return;
    event.preventDefault();
    this.wheelScale = undefined;
    if (command === "width") {
      this.navigation.stop();
      this.clearSelection();
      this.fitWidth = true;
      this.appliedZoom = "width";
      this.viewer.currentScaleValue = "page-width";
      this.events.zoom?.("width");
      return;
    }
    this.zoomTo(this.viewer.currentScale * (command === "in" ? 1.1 : 1 / 1.1));
  };
  private canZoom(target: EventTarget | null) {
    if (
      !this.pdf ||
      this.disposed ||
      !this.container.isConnected ||
      this.container.closest("[inert]")
    )
      return false;
    if (
      document.querySelector(
        '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
      )
    )
      return false;
    return !(
      target instanceof Element &&
      target.closest(
        'input, textarea, select, .translation-document, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="alertdialog"]',
      )
    );
  }
  private zoomTo(scale: number, origin?: number[]) {
    const next = Math.min(5, Math.max(0.25, scale));
    if (!Number.isFinite(next)) return;
    this.navigation.stop();
    this.clearSelection();
    this.fitWidth = false;
    this.viewer.updateScale({
      scaleFactor: next / this.viewer.currentScale,
      drawingDelay: 150,
      origin,
    });
    const applied = this.viewer.currentScale;
    if (this.appliedZoom !== applied) {
      this.appliedZoom = applied;
      this.events.zoom?.(applied);
    }
  }
  private onWheel = (event: WheelEvent) => {
    // Chromium reports trackpad pinch as Ctrl+wheel; macOS Cmd+wheel uses metaKey.
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.defaultPrevented ||
      !this.canZoom(event.target)
    )
      return;
    event.preventDefault();
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    // Focus animations and other navigation can change scale outside this handler.
    // Keep fractional wheel deltas only while the viewer still has our last scale.
    if (this.viewer.currentScale !== this.wheelAppliedScale)
      this.wheelScale = undefined;
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.container.clientHeight
          : 1;
    const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
    // A full wheel event changes scale by at most 20%; smaller pinch deltas
    // remain proportional. Opposite deltas use reciprocal factors.
    const factor = Math.exp((-delta / 100) * Math.log(1.2));
    // Retain sub-percent deltas that PDF.js rounds when applying each scale.
    this.wheelScale = Math.min(
      5,
      Math.max(0.25, (this.wheelScale ?? this.viewer.currentScale) * factor),
    );
    this.zoomTo(this.wheelScale, [event.clientX, event.clientY]);
    this.wheelAppliedScale = this.viewer.currentScale;
  };
  private onMouseUp = (event: MouseEvent) => {
    this.selecting = false;
    if (!isSelectionToolbar(event.target)) {
      // A double click selects the whole sentence instead of one word.
      const layer =
        event.detail === 2 && event.target instanceof Element
          ? event.target.closest(".textLayer")
          : null;
      if (layer && this.container.contains(layer))
        selectSentence(window.getSelection(), layer);
      this.pointer = { x: event.clientX, y: event.clientY };
      this.onSelection();
    }
  };
  private onSelectionChange = () => {
    if (!this.selecting) this.onSelection();
  };
  private onSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel?.rangeCount || sel.isCollapsed || !text) return this.clearState();
    const range = sel.getRangeAt(0);
    const start =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const end =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
    const page = start?.closest<HTMLElement>(".page");
    if (
      !page ||
      !this.container.contains(page) ||
      end?.closest(".page") !== page
    )
      return this.clearState();
    const bounds = page.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.x - bounds.x) / bounds.width,
        y: (r.y - bounds.y) / bounds.height,
        width: r.width / bounds.width,
        height: r.height / bounds.height,
      }));
    this.selection = {
      context: selectionContext(
        range,
        page.querySelector(".textLayer") ?? page,
      ),
      text,
      anchor: selectionAnchor(sel, this.pointer),
      location: {
        type: "pdf",
        page: Number(page.dataset.pageNumber),
        quote: text,
        rects,
      },
    };
    this.events.selection(this.selection);
  };
  getSelection() {
    return this.selection;
  }
  async highlight(annotations: Annotation[]) {
    this.annotationLayer.setAnnotations(annotations);
  }
  private paintHighlights() {
    this.annotationLayer.paint();
  }
  private figureRegions(pageNumber: number): PDFDarkRegion[] {
    return this.blockData
      .filter(
        (block) =>
          block.page === pageNumber &&
          (block.label === "chart" || block.label === "image"),
      )
      .map(({ bounds }) => bounds);
  }
  private figureRegionSignature(blocks: PDFBlock[]) {
    return JSON.stringify(
      blocks
        .filter((block) => block.label === "chart" || block.label === "image")
        .map(({ page, label, bounds }) => [page, label, bounds]),
    );
  }
  private drawColors(page: number): PDFDrawColors | null {
    // Until layout is available, preserve mode must not accidentally recolor
    // an unrecognized vector figure. Adaptive mode needs no figure mask.
    if (
      this.theme.pdfDarkImageMode === "preserve" &&
      !this.blockData.some((block) => block.page === page)
    )
      return null;
    return pdfDrawColors(this.theme, this.figureRegions(page));
  }
  private redrawPages() {
    for (let page = 1; page <= (this.pdf?.numPages ?? 0); page++) {
      if (typeof this.viewer.getPageView !== "function") break;
      this.viewer.getPageView(page - 1)?.reset();
    }
    if (typeof this.viewer.refresh === "function")
      this.viewer.refresh(false, { scale: this.viewer.currentScale });
  }
  async setTheme(theme: ReaderTheme) {
    const previous = this.theme;
    this.theme = theme;
    if (
      previous.mode !== theme.mode ||
      previous.pdfDarkImageMode !== theme.pdfDarkImageMode ||
      previous.pdfDarkContrast !== theme.pdfDarkContrast
    )
      this.linkPreview.invalidate();
    if (this.pdf && this.appliedZoom !== theme.zoom) {
      this.navigation.stop();
      this.fitWidth = theme.zoom === "width";
      this.appliedZoom = theme.zoom;
      this.wheelScale = undefined;
      this.viewer.currentScaleValue = this.fitWidth
        ? "page-width"
        : String(theme.zoom);
    }
    this.container.dataset.theme = theme.mode;
    this.container.dataset.darkContrast = theme.pdfDarkContrast ?? "soft";
    if (
      this.pdf &&
      (previous.mode !== theme.mode ||
        previous.pdfDarkImageMode !== theme.pdfDarkImageMode ||
        previous.pdfDarkContrast !== theme.pdfDarkContrast)
    ) {
      this.redrawPages();
    }
    this.clearSelection();
  }
  async getContext() {
    return this.pageText(this.location.page);
  }
  setBlocks(blocks: PDFBlock[]) {
    const knownPages = new Set(this.blockData.map((block) => block.page));
    const layoutReady =
      this.theme.pdfDarkImageMode === "preserve" &&
      blocks.some((block) => !knownPages.has(block.page));
    const figuresChanged =
      this.figureRegionSignature(this.blockData) !==
      this.figureRegionSignature(blocks);
    this.blockData = blocks;
    this.blocks.setBlocks(blocks);
    this.figureLinks.repaint();
    const drawingChanged =
      (this.theme.pdfDarkImageMode ?? "adaptive") !== "adaptive" &&
      (figuresChanged || layoutReady);
    if (drawingChanged) this.linkPreview.invalidate();
    if (drawingChanged && this.theme.mode === "dark" && this.pdf)
      this.redrawPages();
  }
  async focusReference(location: DocumentLocation, text: string) {
    if (location.type !== "pdf" || this.disposed) return false;
    const block = referenceBlock(this.blockData, location, text);
    if (!block) return false;
    this.fitWidth = false;
    this.clearSelection();
    const reached = await this.navigation.focusBlock(block.id, "source");
    if (reached) {
      this.appliedZoom = this.viewer.currentScale;
      this.events.zoom?.(this.appliedZoom);
      this.location = { ...location, page: block.page };
      this.events.location(
        this.location,
        block.page / (this.pdf?.numPages || 1),
      );
    }
    return reached;
  }
  flashReference(location: DocumentLocation, text: string) {
    if (location.type !== "pdf" || this.disposed) return;
    const block =
      referenceBlock(this.blockData, { ...location, quote: undefined }, "") ??
      referenceBlock(this.blockData, location, text);
    if (location.rects?.length || location.quote) {
      this.locationHighlight.show(
        location,
        text,
        block ? [block.bounds] : undefined,
      );
      return;
    }
    if (block) this.blocks.flashBlock(block.id);
    else this.locationHighlight.show(location, text);
  }
  setSearchBlocks(blockIds: string[]) {
    this.blocks.setSearchBlocks(blockIds);
  }
  async focusBlock(blockId: string, layout: "source" | "parallel") {
    this.fitWidth = false;
    this.clearSelection();
    const reached = await this.navigation.focusBlock(blockId, layout);
    if (reached) {
      this.appliedZoom = this.viewer.currentScale;
      this.events.zoom?.(this.appliedZoom);
    }
  }
  cancelBlockFocus() {
    this.navigation.cancelMotion();
  }
  followBlock(
    anchor: import("@reader/core").PDFReadingAnchor,
    smooth?: boolean,
  ) {
    return this.navigation.follow(anchor, smooth);
  }
  previewCitation(
    location: import("@reader/core").PDFLocation,
    anchor: HTMLAnchorElement,
  ) {
    return this.linkPreview.previewLocation(location, anchor);
  }
  hideCitationPreview() {
    this.linkPreview.hide();
  }
  async resolveCitation(blockId: string, label: string) {
    const block = this.blockData.find((b) => b.id === blockId);
    if (this.pdf && block)
      return resolvePDFCitation(this.pdf, block, label, pdfjs.OPS);
  }
  sentenceRanges(passages: import("@reader/core").PDFPassage[]) {
    return this.navigation.sentenceRanges(passages);
  }
  focusSentences(blockId: string, sources: string[], scroll = false) {
    return this.navigation.focusSentences(blockId, sources, scroll);
  }
  hoverBlock(blockId: string | null) {
    this.blocks.setLinkedBlock(blockId);
  }
  focusPassages(passages: import("@reader/core").PDFPassage[], scroll = false) {
    return this.navigation.focusPassages(passages, scroll);
  }
  matchSentences(
    location: PDFLocation,
    translations: import("@reader/core").TranslationBlock[],
  ) {
    return this.navigation.matchSentences(location, translations);
  }
  async renderBlockImage(
    blockId: string,
    signal: AbortSignal,
    width?: number,
  ): Promise<Blob> {
    const block = this.blockData.find((item) => item.id === blockId);
    if (!block || !this.pdf || this.disposed) throw new Error("图片位置不可用");
    signal.throwIfAborted();
    const page = await this.pdf.getPage(block.page);
    signal.throwIfAborted();
    const base = page.getViewport({ scale: 1 });
    const bounds = block.bounds;
    const area = base.width * bounds.width * base.height * bounds.height;
    const scale = Math.min(
      6,
      Math.sqrt(8_000_000 / area),
      width ? width / (base.width * bounds.width) : Infinity,
    );
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width * bounds.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height * bounds.height));
    const task = page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: [
        1,
        0,
        0,
        1,
        -viewport.width * bounds.x,
        -viewport.height * bounds.y,
      ],
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      background: "white",
    });
    const cancel = () => task.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await task.promise;
      signal.throwIfAborted();
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("无法生成原图预览")),
          "image/png",
        ),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      canvas.width = canvas.height = 0;
    }
  }
  async destroy() {
    if (this.disposed) return;
    this.navigation.destroy();
    this.blocks.destroy();
    this.annotationLayer.destroy();
    this.locationHighlight.clear();
    this.linkPreview.destroy();
    this.removeExternalLinks();
    this.figureLinks.destroy();
    this.disposed = true;
    this.resize.disconnect();
    this.resolutionQuery?.removeEventListener(
      "change",
      this.onResolutionChange,
    );
    clearTimeout(this.resizeTimer);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("keydown", this.onKeyDown);
    this.container.removeEventListener("wheel", this.onWheel);
    this.container.removeEventListener("scroll", this.onScroll);
    this.clearSelection();
    this.viewer.setDocument(null as unknown as pdfjs.PDFDocumentProxy);
    await this.task?.destroy();
    this.container.replaceChildren();
  }
}
