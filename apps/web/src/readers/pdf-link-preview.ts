import type * as pdfjs from "pdfjs-dist";
import {
  defaultTheme,
  type LinkPreview,
  type PDFLocation,
  type ReaderTheme,
} from "@reader/core";
import type { PDFDarkRegion } from "./pdf-dark-mode";
import { pdfDrawColors, type PDFDrawColors } from "./pdf-draw-colors";

/** PDF.js writes internal targets as `#<escaped name or JSON array>` or `#page=N`. */
export function parseDestinationHash(hash: string): {
  dest?: string | unknown[];
  page?: number;
} {
  let raw = hash.replace(/^#/, "");
  try {
    raw = unescape(raw);
  } catch {
    /* keep the raw text */
  }
  const page = /(?:^|&)page=(\d+)/.exec(raw);
  if (page) return { page: Number(page[1]) };
  if (raw.startsWith("[")) {
    try {
      const dest: unknown = JSON.parse(raw);
      if (Array.isArray(dest)) return { dest };
    } catch {
      /* not an explicit destination */
    }
  }
  const named = /(?:^|&)nameddest=([^&]+)/.exec(raw);
  return raw ? { dest: named ? named[1] : raw } : {};
}

/** The left/top of an explicit destination in PDF user space, if it has one. */
export function destinationPoint(dest: unknown[]) {
  const mode = (dest[1] as { name?: string } | undefined)?.name;
  const num = (value: unknown) => (typeof value === "number" ? value : null);
  switch (mode) {
    case "XYZ":
      return { left: num(dest[2]), top: num(dest[3]) };
    case "FitH":
    case "FitBH":
      return { left: null, top: num(dest[2]) };
    case "FitR":
      return { left: num(dest[2]), top: num(dest[5]) };
    default:
      return { left: null, top: null };
  }
}

const PREVIEW_WIDTH = 580;
const HOVER_DELAY = 300;

/** Shows the target region of internal links (citations, figures, sections). */
export class PDFLinkPreview {
  private timer?: ReturnType<typeof setTimeout>;
  private hovered?: HTMLAnchorElement;
  private request = 0;
  private previews = new Map<string, Promise<string>>();
  private previewAbort = new AbortController();
  private epoch = 0;
  private renders = new Set<() => void>();
  private disposed = false;
  constructor(
    private container: HTMLElement,
    private pdf: () => pdfjs.PDFDocumentProxy | undefined,
    private show: (preview: LinkPreview | null) => void,
    private follow: () => void,
    private theme: () => ReaderTheme = () => defaultTheme,
    private figureRegions: (page: number) => PDFDarkRegion[] = () => [],
    private drawColors?: (page: number) => PDFDrawColors | null,
  ) {
    container.addEventListener("pointerover", this.over);
    container.addEventListener("focusin", this.over);
    container.addEventListener("focusout", this.out);
    container.addEventListener("pointerout", this.out);
    container.addEventListener("click", this.click, true);
    container.addEventListener("scroll", this.hide, { passive: true });
  }
  private link(target: EventTarget | null) {
    return target instanceof Element
      ? target.closest<HTMLAnchorElement>(
          ".annotationLayer a.internalLink, .annotationLayer [data-internal-link] a",
        )
      : null;
  }
  private over = (event: MouseEvent | FocusEvent) => {
    const link = this.link(event.target);
    if (!link || link === this.hovered) return;
    this.hide();
    this.hovered = link;
    this.timer = setTimeout(() => void this.preview(link), HOVER_DELAY);
  };
  private out = (event: MouseEvent | FocusEvent) => {
    const link = this.link(event.target);
    if (!link || link.contains(event.relatedTarget as Node | null)) return;
    this.hide();
  };
  private click = (event: MouseEvent) => {
    if (!this.link(event.target)) return;
    this.hide();
    // Record the reading position before PDF.js moves to the target.
    this.follow();
  };
  hide = () => {
    clearTimeout(this.timer);
    this.request++;
    this.hovered = undefined;
    this.show(null);
  };
  private async target(link: HTMLAnchorElement) {
    const pdf = this.pdf();
    if (!pdf) return;
    const hash = link.hash || link.getAttribute("href") || "";
    const { dest, page } = parseDestinationHash(hash);
    if (page) return { pageIndex: page - 1, left: null, top: null };
    let explicit = dest;
    if (typeof explicit === "string")
      explicit = (await pdf.getDestination(explicit)) ?? undefined;
    if (!Array.isArray(explicit) || !explicit.length) return;
    const ref = explicit[0];
    const pageIndex =
      typeof ref === "number"
        ? ref
        : await pdf.getPageIndex(ref as { num: number; gen: number });
    return { pageIndex, ...destinationPoint(explicit) };
  }
  invalidate() {
    this.request++;
    this.epoch++;
    this.previewAbort.abort();
    this.previewAbort = new AbortController();
    for (const cancel of this.renders) cancel();
    this.previews.clear();
  }
  private async renderCrop(
    pdf: pdfjs.PDFDocumentProxy,
    page: number,
    bounds: PDFDarkRegion,
    width: number,
    signal: AbortSignal,
  ) {
    const epoch = this.epoch;
    const theme = this.theme();
    signal.throwIfAborted();
    if (this.disposed || this.pdf() !== pdf) throw new Error("文档已关闭");
    const proxy = await pdf.getPage(page);
    signal.throwIfAborted();
    if (this.disposed || this.pdf() !== pdf || epoch !== this.epoch)
      throw new Error("预览已失效");
    const base = proxy.getViewport({ scale: 1 });
    const cropWidth = base.width * bounds.width;
    const cropHeight = base.height * bounds.height;
    // Bound both memory and canvas dimensions when a window is enlarged.
    const scale = Math.min(
      Math.max(1, width) / cropWidth,
      Math.sqrt(8_000_000 / (cropWidth * cropHeight)),
      8192 / Math.max(cropWidth, cropHeight),
    );
    const viewport = proxy.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(cropWidth * scale));
    canvas.height = Math.max(1, Math.floor(cropHeight * scale));
    const context = canvas.getContext("2d")!;
    const task = proxy.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: [
        1,
        0,
        0,
        1,
        -viewport.width * bounds.x,
        -viewport.height * bounds.y,
      ],
      background: "white",
      readerColorAdapter: this.drawColors
        ? this.drawColors(page)
        : pdfDrawColors(theme, this.figureRegions(page)),
    });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      task.cancel();
    };
    this.renders.add(cancel);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await task.promise;
      signal.throwIfAborted();
      if (cancelled || this.disposed || epoch !== this.epoch)
        throw new Error("预览渲染已取消");
      return canvas.toDataURL("image/png");
    } finally {
      signal.removeEventListener("abort", cancel);
      this.renders.delete(cancel);
      canvas.width = canvas.height = 0;
    }
  }
  private async preview(link: HTMLAnchorElement) {
    const request = ++this.request;
    try {
      const target = await this.target(link);
      if (!target || request !== this.request) return;
      await this.showTarget(target, link, request);
    } catch {
      /* a broken destination simply has no preview */
    }
  }
  async previewLocation(location: PDFLocation, link: HTMLAnchorElement) {
    const request = ++this.request;
    try {
      const page = await this.pdf()?.getPage(location.page);
      if (!page || request !== this.request) return;
      const view = page.getViewport({ scale: 1 });
      const [left, top] = view.convertToPdfPoint(
        (location.x ?? 0) * view.width,
        (location.y ?? 0) * view.height,
      );
      await this.showTarget(
        { pageIndex: location.page - 1, left, top },
        link,
        request,
      );
    } catch {
      /* a broken destination simply has no preview */
    }
  }
  private async showTarget(
    target: { pageIndex: number; left: number | null; top: number | null },
    link: HTMLAnchorElement,
    request: number,
  ) {
    const pdf = this.pdf()!;
    const proxy = await pdf.getPage(target.pageIndex + 1);
    const base = proxy.getViewport({ scale: 1 });
    const top =
      target.top === null
        ? 0
        : Math.min(
            base.height - 1,
            Math.max(0, base.convertToViewportPoint(0, target.top)[1] - 10),
          );
    // A target in the right half starts a right column: show only that column.
    const right = target.left !== null && target.left > base.width / 2 - 10;
    const left = right ? base.width / 2 : 0;
    const width = right ? base.width / 2 : base.width;
    const height = Math.min(base.height - top, base.height * 0.3);
    const bounds = {
      x: left / base.width,
      y: top / base.height,
      width: width / base.width,
      height: height / base.height,
    };
    const pixels = Math.ceil(PREVIEW_WIDTH * (window.devicePixelRatio || 1));
    const key = JSON.stringify([target.pageIndex, bounds, pixels]);
    let image = this.previews.get(key);
    if (!image) {
      image = this.renderCrop(
        pdf,
        target.pageIndex + 1,
        bounds,
        pixels,
        this.previewAbort.signal,
      );
      this.previews.set(key, image);
      if (this.previews.size > 4)
        this.previews.delete(this.previews.keys().next().value!);
      image.catch(() => {
        if (this.previews.get(key) === image) this.previews.delete(key);
      });
    }
    const preview = await image;
    if (request !== this.request || !link.isConnected) return;
    const rect = link.getBoundingClientRect();
    const destination = base.convertToViewportPoint(
      target.left ?? 0,
      target.top ?? 0,
    );
    this.show({
      anchor: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      page: target.pageIndex + 1,
      image: preview,
      ratio: width / height,
      location: {
        type: "pdf",
        page: target.pageIndex + 1,
        x:
          target.left === null
            ? 0
            : Math.max(0, Math.min(1, destination[0] / base.width)),
        y:
          target.top === null
            ? 0
            : Math.max(0, Math.min(1, destination[1] / base.height)),
      },
      renderImage: (pixels, signal) =>
        this.renderCrop(pdf, target.pageIndex + 1, bounds, pixels, signal),
    });
  }
  destroy() {
    this.disposed = true;
    this.hide();
    this.invalidate();
    this.container.removeEventListener("pointerover", this.over);
    this.container.removeEventListener("focusin", this.over);
    this.container.removeEventListener("focusout", this.out);
    this.container.removeEventListener("pointerout", this.out);
    this.container.removeEventListener("click", this.click, true);
    this.container.removeEventListener("scroll", this.hide);
    this.previews.clear();
  }
}
