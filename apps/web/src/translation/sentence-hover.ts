import { reducedMotion } from "../motion";
import { formulaAwareRects } from "./formula-highlight";
/** Hover uses small composited layers; never animate inherited reader styles. */
export class SentenceHover {
  private key = "";
  private current?: HTMLDivElement;
  private outgoing?: HTMLDivElement;
  private animations = new Map<HTMLElement, Animation>();
  private dirty = false;
  constructor(private host: HTMLElement) {}
  invalidate() {
    this.dirty = true;
  }
  private remove(layer?: HTMLDivElement) {
    if (!layer) return;
    this.animations.get(layer)?.cancel();
    this.animations.delete(layer);
    layer.remove();
  }
  private fade(layer: HTMLDivElement, entering: boolean) {
    if (!layer.animate || reducedMotion()) {
      if (!entering) this.remove(layer);
      return;
    }
    const from = entering ? "0" : getComputedStyle(layer).opacity;
    this.animations.get(layer)?.cancel();
    const animation = layer.animate(
      [{ opacity: from }, { opacity: entering ? 1 : 0 }],
      { duration: 160, easing: "ease-out", fill: "forwards" },
    );
    this.animations.set(layer, animation);
    void animation.finished
      .then(() => {
        if (this.animations.get(layer) !== animation) return;
        this.animations.delete(layer);
        if (!entering) layer.remove();
        animation.cancel();
      })
      .catch(() => {});
  }
  show(key: string, ranges: Range[]) {
    if (key === this.key && this.current && !this.dirty) return;
    this.dirty = false;
    // Read all geometry before adding any DOM or starting animations.
    const hostBounds = this.host.getBoundingClientRect();
    const clips = new Map<Element, DOMRect>();
    // A formula hovers as one box, painted once across its text runs.
    const formulas = new Set<HTMLElement>();
    const boxes = ranges.flatMap((range) => {
      const element =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as Element);
      if (element?.closest("[inert]")) return [];
      const pane =
        element?.closest(
          ".pdf-container, .epub-web-reader, .translation-document",
        ) ?? this.host;
      if (!clips.has(pane)) clips.set(pane, pane.getBoundingClientRect());
      const clip = clips.get(pane)!;
      return formulaAwareRects([range], formulas).flatMap((rect) => {
        const left = Math.max(rect.left, clip.left, hostBounds.left),
          top = Math.max(rect.top, clip.top, hostBounds.top);
        const right = Math.min(rect.right, clip.right, hostBounds.right),
          bottom = Math.min(rect.bottom, clip.bottom, hostBounds.bottom);
        return right > left && bottom > top
          ? [{ left, top, width: right - left, height: bottom - top }]
          : [];
      });
    });
    if (!boxes.length) {
      this.clear();
      return;
    }
    const layer = document.createElement("div");
    layer.className = "neoread-sentence-hover-layer";
    layer.setAttribute("aria-hidden", "true");
    const left = Math.min(...boxes.map((b) => b.left)),
      top = Math.min(...boxes.map((b) => b.top));
    const right = Math.max(...boxes.map((b) => b.left + b.width)),
      bottom = Math.max(...boxes.map((b) => b.top + b.height));
    Object.assign(layer.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
      pointerEvents: "none",
      zIndex: "7",
      contain: "strict",
      willChange: "opacity",
      mixBlendMode: this.host.dataset.theme === "dark" ? "screen" : "multiply",
    });
    for (const box of boxes) {
      const mark = document.createElement("div");
      mark.className = "neoread-sentence-hover-mark";
      Object.assign(mark.style, {
        position: "absolute",
        left: `${box.left - left}px`,
        top: `${box.top - top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
      layer.append(mark);
    }
    const same = key === this.key;
    this.remove(this.outgoing);
    if (same) this.remove(this.current);
    else if (this.current) {
      this.outgoing = this.current;
      this.fade(this.outgoing, false);
    }
    this.key = key;
    this.current = layer;
    document.body.append(layer);
    if (!same) this.fade(layer, true);
  }
  clear(immediate = false) {
    this.key = "";
    if (immediate) {
      this.remove(this.current);
      this.remove(this.outgoing);
      this.current = undefined;
      this.outgoing = undefined;
      return;
    }
    if (this.current) {
      this.remove(this.outgoing);
      this.outgoing = this.current;
      this.current = undefined;
      this.fade(this.outgoing, false);
    }
  }
  destroy() {
    this.clear(true);
  }
}
