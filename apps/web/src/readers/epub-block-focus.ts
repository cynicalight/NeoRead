import { reducedMotion } from "../motion";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EPUBReadingBlock, PDFBlockAction } from "@neoread/core";
import { BlockActions } from "../BlockActions";

// EPUB paragraphs are already DOM blocks: hover, counterpart and focus boxes
// follow the rendered element (or the text runs of a mixed container) instead
// of a parsed page layout, matching the PDF block interaction.

const blockSelector = "[data-epub-run], [data-epub-block]";
// Includes the toolbar's padding, which bridges the gap above the block.
const blockActionTarget = "[data-block-action], .block-actions";
// Breathing room around the text, like the margin of a parsed PDF block.
const padX = 8,
  padY = 4;

export function epubBlockId(target: EventTarget | null) {
  const element =
    target instanceof Element
      ? target.closest<HTMLElement>(blockSelector)
      : null;
  return element?.dataset.epubRun ?? element?.dataset.epubBlock;
}

/** Viewport rect covering every rendered part of a block. */
export function epubBlockRect(container: HTMLElement, id: string) {
  const value = JSON.stringify(id);
  let top = Infinity,
    left = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const node of container.querySelectorAll<HTMLElement>(
    `[data-epub-block=${value}], [data-epub-run=${value}]`,
  )) {
    const r = node.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (top === Infinity) return;
  return {
    top: top - padY,
    left: left - padX,
    width: right - left + padX * 2,
    height: bottom - top + padY * 2,
  };
}

export class EPUBBlockOverlay {
  private hover = this.box("neoread-block-hover");
  private linked = this.box("neoread-block-hover neoread-block-counterpart");
  private focusBox = this.box("neoread-block-hover neoread-block-focus");
  private hovered?: string;
  private actions: Root;
  private actionsFor?: string;
  private linkedId: string | null = null;
  private focusId: string | null = null;
  private pressed?: { id: string; x: number; y: number };
  private operation = 0;
  private abort = new AbortController();
  private fade?: Animation;

  constructor(
    private container: HTMLElement,
    private onHover: (id: string | null) => void,
    private onFocus: (id: string) => void,
    private blocks: () => EPUBReadingBlock[] = () => [],
    private onAction: (
      block: EPUBReadingBlock,
      action: PDFBlockAction,
    ) => void = () => {},
  ) {
    this.actions = createRoot(this.hover);
    this.focusBox.addEventListener("animationend", () => {
      if (!this.focusId) this.focusBox.remove();
    });
    const signal = this.abort.signal;
    container.addEventListener("pointermove", this.move, { signal });
    container.addEventListener("pointerleave", this.leave, { signal });
    container.addEventListener("pointerdown", this.press, { signal });
    container.addEventListener("scroll", this.clear, {
      passive: true,
      signal,
    });
    // Wheel, touchpad and keyboard scrolling interrupt a focus movement.
    for (const name of ["wheel", "keydown"])
      container.addEventListener(name, () => this.cancel(), {
        passive: true,
        signal,
      });
  }

  private box(className: string) {
    const element = document.createElement("div");
    element.className = className;
    element.setAttribute("aria-hidden", "true");
    element.dataset.blockKind = "text";
    return element;
  }

  private place(element: HTMLElement, id: string) {
    const rect = epubBlockRect(this.container, id);
    if (!rect) {
      element.remove();
      return false;
    }
    const view = this.container.getBoundingClientRect();
    Object.assign(element.style, {
      top: `${rect.top - view.top + this.container.scrollTop}px`,
      left: `${rect.left - view.left + this.container.scrollLeft}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    element.dataset.blockId = id;
    element.dataset.blockKind = this.container.querySelector(
      `img[data-epub-block=${JSON.stringify(id)}]`,
    )
      ? "image"
      : "text";
    if (element === this.hover) {
      this.fade?.cancel();
      this.fade = undefined;
      element.inert = false;
    }
    if (element.parentElement !== this.container)
      this.container.append(element);
    return true;
  }

  /**
   * The block under the pointer. As with PDF block bounds, the padded box
   * around the hovered block still counts, so the pointer can cross its margin
   * to the toolbar above it.
   */
  private blockAt(event: MouseEvent) {
    const id = epubBlockId(event.target);
    if (id) return id;
    const current = this.hovered ?? this.pressed?.id;
    const rect = current && epubBlockRect(this.container, current);
    if (
      rect &&
      event.clientX >= rect.left &&
      event.clientX <= rect.left + rect.width &&
      event.clientY >= rect.top &&
      event.clientY <= rect.top + rect.height
    )
      return current;
  }

  private move = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(blockActionTarget)) return;
    if (event.buttons || window.getSelection()?.toString().trim()) {
      this.clear();
      return;
    }
    const id = this.blockAt(event);
    if (!id) {
      this.leave();
      return;
    }
    if (id !== this.focusId) {
      this.place(this.hover, id);
      this.showActions(id);
    } else this.hover.remove();
    if (this.hovered !== id) {
      this.hovered = id;
      this.onHover(id);
    }
  };

  private showActions(id: string) {
    if (this.actionsFor === id) return;
    const block = this.blocks().find((b) => b.id === id);
    this.actionsFor = block?.id;
    this.actions.render(
      block
        ? createElement(BlockActions<EPUBReadingBlock>, {
            block,
            onAction: this.onAction,
          })
        : null,
    );
  }

  // Fade out like the PDF hover box; scrolling removes it at once.
  private hideHover(immediate: boolean) {
    const box = this.hover;
    if (!box.parentElement || this.fade) return;
    if (immediate || !box.animate || reducedMotion()) {
      box.remove();
      return;
    }
    box.inert = true;
    const fade = box.animate(
      [{ opacity: getComputedStyle(box).opacity }, { opacity: 0 }],
      { duration: 160, easing: "ease-out", fill: "forwards" },
    );
    this.fade = fade;
    void fade.finished
      .then(() => {
        if (this.fade !== fade) return;
        box.remove();
        this.fade = undefined;
        fade.cancel();
      })
      .catch(() => {});
  }

  private leave = () => this.dismiss(false);
  private clear = () => this.dismiss(true);
  private dismiss(immediate: boolean) {
    this.hideHover(immediate);
    if (this.hovered) {
      this.hovered = undefined;
      this.onHover(null);
    }
  }

  private press = (event: PointerEvent) => {
    this.cancel();
    this.pressed = undefined;
    if ((event.target as Element | null)?.closest(blockActionTarget)) return;
    const id = event.button === 0 ? this.blockAt(event) : undefined;
    if (id) this.pressed = { id, x: event.clientX, y: event.clientY };
  };

  /** A plain click on a block, after links and annotations declined it. */
  click(event: MouseEvent) {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (
      !pressed ||
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5 ||
      window.getSelection()?.toString().trim() ||
      (event.target as Element | null)?.closest("a,button,input,textarea") ||
      this.blockAt(event) !== pressed.id
    )
      return;
    this.clear();
    this.onFocus(pressed.id);
  }

  setLinkedBlock(id: string | null) {
    this.linkedId = id;
    if (!id || id === this.focusId || !this.place(this.linked, id))
      this.linked.remove();
  }

  /**
   * Smoothly center the block, or align a block taller than the viewport to
   * its top. The box shows while moving and fades once the block arrives.
   */
  async focus(id: string) {
    if (!epubBlockRect(this.container, id)) return false;
    const operation = ++this.operation;
    this.focusId = id;
    delete this.focusBox.dataset.fading;
    this.hover.remove();
    this.linked.remove();
    const target = () => {
      const rect = epubBlockRect(this.container, id);
      if (!rect) return;
      const view = this.container.getBoundingClientRect();
      const offset = Math.max(
        Math.min(padY * 4, this.container.clientHeight / 2),
        (this.container.clientHeight - rect.height) / 2,
      );
      return { current: rect.top - view.top, wanted: offset };
    };
    const start = target();
    if (!start) return false;
    const from = start.current;
    const reduced = reducedMotion();
    let started: number | undefined;
    await new Promise<void>((resolve) => {
      const frame = (now: number) => {
        if (operation !== this.operation) {
          resolve();
          return;
        }
        started ??= now;
        const progress = reduced ? 1 : Math.min(1, (now - started) / 240);
        const ease = 1 - (1 - progress) ** 3;
        // Measure every frame: chapters loading above may shift the block.
        const position = target();
        if (position) {
          const max = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight,
          );
          this.container.scrollTop = Math.min(
            max,
            Math.max(
              0,
              this.container.scrollTop +
                position.current -
                (from + (position.wanted - from) * ease),
            ),
          );
          if (!reduced) this.place(this.focusBox, id);
        }
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    if (operation !== this.operation) return false;
    this.release();
    return true;
  }

  private release() {
    this.focusId = null;
    if (reducedMotion() || !this.focusBox.parentElement) this.focusBox.remove();
    else this.focusBox.dataset.fading = "";
    if (this.linkedId) this.setLinkedBlock(this.linkedId);
  }

  cancel() {
    if (!this.focusId) return;
    this.operation++;
    this.release();
  }

  destroy() {
    this.operation++;
    this.abort.abort();
    this.actions.unmount();
    this.fade?.cancel();
    this.hover.remove();
    this.linked.remove();
    this.focusBox.remove();
  }
}
