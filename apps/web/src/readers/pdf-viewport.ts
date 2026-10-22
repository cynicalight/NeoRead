import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";

type Anchor = { page: HTMLElement; x: number; y: number };
/** Preserve the page point under the viewport center through panel resizing. */
export class PDFViewport {
  private size?: { width: number; height: number };
  private basis?: { width: number; scale: number };
  private anchor?: Anchor;
  private scroll = { left: 0, top: 0 };
  constructor(
    private host: HTMLElement,
    private viewer: PDFViewer,
  ) {}
  reset() {
    if (!this.visible()) return;
    this.size = {
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    };
    this.basis = {
      width: this.host.clientWidth,
      scale: this.viewer.currentScale,
    };
    this.capture();
  }
  remember() {
    if (!this.visible()) return;
    if (!this.size) {
      this.reset();
      return;
    }
    // ResizeObserver runs after layout; do not replace the old anchor with new geometry.
    if (
      this.size.width !== this.host.clientWidth ||
      this.size.height !== this.host.clientHeight
    )
      return;
    this.capture();
  }
  scaleChanged() {
    if (
      this.size?.width === this.host.clientWidth &&
      this.size.height === this.host.clientHeight
    )
      this.reset();
  }
  private visible() {
    return (
      this.host.isConnected &&
      this.host.clientWidth > 0 &&
      this.host.clientHeight > 0 &&
      Number.isFinite(this.viewer.currentScale) &&
      this.viewer.currentScale > 0 &&
      !this.host.closest("[inert]")
    );
  }
  private capture() {
    const view = this.host.getBoundingClientRect();
    const x = view.left + this.host.clientLeft + this.host.clientWidth / 2;
    const y = view.top + this.host.clientTop + this.host.clientHeight / 2;
    let page = this.host.ownerDocument
      .elementFromPoint?.(x, y)
      ?.closest<HTMLElement>(".page");
    if (!page || !this.host.contains(page)) {
      let distance = Infinity;
      page = undefined;
      for (
        let n = Math.max(0, this.viewer.currentPageNumber - 3);
        n <= this.viewer.currentPageNumber + 1;
        n++
      ) {
        const node = this.viewer.getPageView(n)?.div;
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const next =
          Math.max(rect.left - x, x - rect.right, 0) +
          Math.max(rect.top - y, y - rect.bottom, 0);
        if (rect.width > 0 && rect.height > 0 && next < distance) {
          page = node;
          distance = next;
        }
      }
    }
    const rect = page?.getBoundingClientRect();
    this.anchor =
      page && rect?.width && rect.height
        ? {
            page,
            x: (x - rect.left) / rect.width,
            y: (y - rect.top) / rect.height,
          }
        : undefined;
    this.scroll = { left: this.host.scrollLeft, top: this.host.scrollTop };
  }
  resize(fitWidth: boolean, updateInsets: () => void) {
    if (!this.visible()) return;
    if (!this.size || !this.basis) {
      this.reset();
      return;
    }
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (width === this.size.width && height === this.size.height) return;
    const before = this.size,
      anchor = this.anchor,
      scroll = this.scroll;
    const oldScale = this.viewer.currentScale;
    updateInsets();
    if (fitWidth) this.viewer.currentScaleValue = "page-width";
    else {
      // Use a fixed basis so rounding/clamping cannot accumulate over repeated drags.
      const target = Math.max(
        0.1,
        Math.min(5, (this.basis.scale * width) / this.basis.width),
      );
      if (Math.abs(target - oldScale) > 0.0001)
        this.viewer.updateScale({
          scaleFactor: target / oldScale,
          drawingDelay: 100,
        });
    }
    const scale = this.viewer.currentScale;
    const view = this.host.getBoundingClientRect();
    if (anchor?.page.isConnected) {
      const page = anchor.page.getBoundingClientRect();
      this.host.scrollLeft +=
        page.left +
        anchor.x * page.width -
        view.left -
        this.host.clientLeft -
        width / 2;
      this.host.scrollTop +=
        page.top +
        anchor.y * page.height -
        view.top -
        this.host.clientTop -
        height / 2;
    } else {
      const ratio = scale / oldScale;
      this.host.scrollLeft = Math.max(
        0,
        (scroll.left + before.width / 2) * ratio - width / 2,
      );
      this.host.scrollTop = Math.max(
        0,
        (scroll.top + before.height / 2) * ratio - height / 2,
      );
    }
    this.size = {
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    };
    this.capture();
    return {
      scale,
      widthRatio: width / before.width,
      scaleChanged: Math.abs(scale - oldScale) > 0.0001,
    };
  }
}
