import type * as pdfjs from "pdfjs-dist";
import {
  defaultTheme,
  type LinkPreview,
  type PDFLocation,
  type ReaderTheme,
} from "@reader/core";
import {
  imageRegions,
  processPDFPagePixels,
  type PDFDarkRegion,
} from "./pdf-dark-mode";

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

const PREVIEW_WIDTH = 460;
const HOVER_DELAY = 300;

/** Shows the target region of internal links (citations, figures, sections). */
export class PDFLinkPreview {
  private timer?: ReturnType<typeof setTimeout>;
  private hovered?: HTMLAnchorElement;
  private request = 0;
  private pages = new Map<number, Promise<HTMLCanvasElement>>();
  constructor(
    private container: HTMLElement,
    private pdf: () => pdfjs.PDFDocumentProxy | undefined,
    private show: (preview: LinkPreview | null) => void,
    private follow: () => void,
    private theme: () => ReaderTheme = () => defaultTheme,
    private figureRegions: (page: number) => PDFDarkRegion[] = () => [],
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
  private render(pageIndex: number) {
    let page = this.pages.get(pageIndex);
    if (!page) {
      page = (async () => {
        const proxy = await this.pdf()!.getPage(pageIndex + 1);
        const base = proxy.getViewport({ scale: 1 });
        const scale =
          (PREVIEW_WIDTH / base.width) *
          Math.min(2, window.devicePixelRatio || 1);
        const viewport = proxy.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await proxy.render({
          canvas,
          canvasContext: canvas.getContext("2d")!,
          viewport,
          background: "white",
          recordImages: true,
        }).promise;
        const theme = this.theme();
        if (theme.mode === "dark") {
          const context = canvas.getContext("2d")!;
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const transformed = processPDFPagePixels(
            pixels.data,
            canvas.width,
            canvas.height,
            imageRegions({
              coordinates: proxy.imageCoordinates,
            }),
            this.figureRegions(pageIndex + 1),
            theme.pdfDarkImageMode ?? "adaptive",
            theme.pdfDarkContrast ?? "soft",
          );
          const output = new Uint8ClampedArray(
            canvas.width * canvas.height * 4,
          );
          output.set(transformed);
          context.putImageData(
            new ImageData(output, canvas.width, canvas.height),
            0,
            0,
          );
        }
        return canvas;
      })();
      this.pages.set(pageIndex, page);
      // Keep a few recently previewed pages.
      if (this.pages.size > 4)
        this.pages.delete(this.pages.keys().next().value!);
      page.catch(() => this.pages.delete(pageIndex));
    }
    return page;
  }
  invalidate() {
    this.request++;
    for (const page of this.pages.values())
      void page
        .then((canvas) => {
          canvas.width = 0;
          canvas.height = 0;
        })
        .catch(() => {});
    this.pages.clear();
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
    const canvas = await this.render(target.pageIndex);
    if (request !== this.request || !link.isConnected) return;
    const ratio = canvas.width / base.width;
    const top =
      target.top === null
        ? 0
        : Math.max(0, base.convertToViewportPoint(0, target.top)[1] - 10);
    // A target in the right half starts a right column: show only that column.
    const right = target.left !== null && target.left > base.width / 2 - 10;
    const left = right ? base.width / 2 : 0;
    const width = right ? base.width / 2 : base.width;
    const height = Math.min(base.height - top, base.height * 0.3);
    const crop = document.createElement("canvas");
    crop.width = Math.round(width * ratio);
    crop.height = Math.round(height * ratio);
    crop
      .getContext("2d")!
      .drawImage(
        canvas,
        left * ratio,
        top * ratio,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );
    const rect = link.getBoundingClientRect();
    this.show({
      anchor: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      page: target.pageIndex + 1,
      image: crop.toDataURL("image/png"),
      ratio: crop.width / crop.height,
    });
  }
  destroy() {
    this.hide();
    this.invalidate();
    this.container.removeEventListener("pointerover", this.over);
    this.container.removeEventListener("focusin", this.over);
    this.container.removeEventListener("focusout", this.out);
    this.container.removeEventListener("pointerout", this.out);
    this.container.removeEventListener("click", this.click, true);
    this.container.removeEventListener("scroll", this.hide);
    this.pages.clear();
  }
}
