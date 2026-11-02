import { reducedMotion } from "../motion";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BlockActions } from "../BlockActions";
import {
  isPDFPageDecoration,
  type PDFBlock,
  type PDFBlockAction,
  type PDFLocation,
} from "@neoread/core";
// Includes the toolbar's padding, which bridges the gap above the block.
const blockActionTarget = "[data-block-action], .block-actions";
export function hitBlock(
  blocks: PDFBlock[],
  page: number,
  x: number,
  y: number,
) {
  return blocks
    .filter(
      (b) =>
        b.page === page &&
        !isPDFPageDecoration(b) &&
        (b.image || b.text.trim()) &&
        x >= b.bounds.x &&
        y >= b.bounds.y &&
        x <= b.bounds.x + b.bounds.width &&
        y <= b.bounds.y + b.bounds.height,
    )
    .sort(
      (a, b) =>
        a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height,
    )[0];
}
export function referenceBlock(
  blocks: PDFBlock[],
  location: PDFLocation,
  text: string,
) {
  const rect = location.rects?.[0];
  if (rect) {
    const hit = hitBlock(
      blocks,
      location.page,
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    if (hit) return hit;
  }
  const excerpt = (location.quote || text)
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  if (excerpt) {
    const needle = excerpt.slice(0, 48);
    const match = blocks.find(
      (block) =>
        block.page === location.page &&
        !isPDFPageDecoration(block) &&
        block.text.replace(/\s+/g, " ").toLocaleLowerCase().includes(needle),
    );
    if (match) return match;
  }
  if (location.x !== undefined && location.y !== undefined)
    return hitBlock(blocks, location.page, location.x, location.y);
}
// Pointer observation leaves the PDF text and links as the event targets.
export class PDFBlockOverlay {
  private blocks: PDFBlock[] = [];
  private fades = new Map<HTMLElement, Animation>();
  private overlay: HTMLDivElement;
  private root: Root;
  private active?: PDFBlock;
  private hovered?: string;
  private linkedId: string | null = null;
  private focusId: string | null = null;
  private tourTarget = document.createElement("div");
  private focus = document.createElement("div");
  private referenceFlash = document.createElement("div");
  private referenceFlashId: string | null = null;
  private referenceFlashTimer?: ReturnType<typeof setTimeout>;
  private linked = document.createElement("div");
  private searchBlocks = new Map<string, HTMLDivElement>();
  private pressed?: { id: string; x: number; y: number };
  constructor(
    private host: HTMLElement,
    private onAction: (
      block: PDFBlock,
      action: PDFBlockAction,
    ) => void = () => {},
    private onHover: (block: PDFBlock | null) => void = () => {},
    private onFocus: (block: PDFBlock) => boolean = () => false,
  ) {
    // A geometry-only landmark: real pointer events still reach PDF text.
    this.tourTarget.dataset.tour = "source-block";
    this.tourTarget.setAttribute("aria-hidden", "true");
    Object.assign(this.tourTarget.style, {
      position: "absolute",
      pointerEvents: "none",
    });
    this.tourTarget.onclick = () => {
      const block = this.blocks.find(
        (b) => b.id === this.tourTarget.dataset.blockId,
      );
      if (block && this.onFocus(block))
        this.tourTarget.dataset.demonstrated = "true";
    };
    this.overlay = document.createElement("div");
    this.overlay.className = "neoread-block-hover";
    this.root = createRoot(this.overlay);
    this.linked.className = "neoread-block-hover neoread-block-counterpart";
    this.linked.setAttribute("aria-hidden", "true");
    this.focus.className = "neoread-block-hover neoread-block-focus";
    this.focus.setAttribute("aria-hidden", "true");
    this.referenceFlash.className = "neoread-block-reference-flash";
    this.referenceFlash.setAttribute("aria-hidden", "true");
    this.focus.addEventListener("animationend", () => {
      if (!this.focusId) this.focus.remove();
    });
    host.addEventListener("pointermove", this.move);
    host.addEventListener("pointerleave", this.leave);
    host.addEventListener("pointerdown", this.press);
    host.addEventListener("click", this.click, true);
    host.addEventListener("pointerup", this.move);
    host.addEventListener("scroll", this.clear, { passive: true });
  }
  setBlocks(blocks: PDFBlock[]) {
    this.blocks = blocks.filter((b) => !isPDFPageDecoration(b));
    // Refreshing the same parsed blocks must not dismiss a stationary hover.
    if (this.active) {
      const updated = this.blocks.find((b) => b.id === this.active?.id);
      if (!updated || JSON.stringify(updated) !== JSON.stringify(this.active))
        this.clear();
    }
    this.repaint();
  }
  setSearchBlocks(blockIds: string[]) {
    const wanted = new Set(blockIds);
    for (const [id, element] of this.searchBlocks) {
      if (!wanted.has(id)) {
        element.remove();
        this.searchBlocks.delete(id);
      }
    }
    for (const id of wanted) {
      if (!this.searchBlocks.has(id)) {
        const element = document.createElement("div");
        element.className = "neoread-block-search-hit";
        element.setAttribute("aria-hidden", "true");
        this.searchBlocks.set(id, element);
      }
    }
    this.repaint();
  }
  private hide(element: HTMLElement, immediate = false) {
    if (!element.parentElement) return;
    if (immediate || !element.animate || reducedMotion()) {
      this.fades.get(element)?.cancel();
      this.fades.delete(element);
      element.remove();
      return;
    }
    if (this.fades.has(element)) return;
    element.inert = true;
    const animation = element.animate(
      [{ opacity: getComputedStyle(element).opacity }, { opacity: 0 }],
      { duration: 160, easing: "ease-out", fill: "forwards" },
    );
    this.fades.set(element, animation);
    void animation.finished
      .then(() => {
        if (this.fades.get(element) !== animation) return;
        element.remove();
        this.fades.delete(element);
        animation.cancel();
      })
      .catch(() => {});
  }
  private show(element: HTMLElement, page: HTMLElement) {
    this.fades.get(element)?.cancel();
    this.fades.delete(element);
    element.inert = false;
    if (element.parentElement !== page) page.append(element);
  }
  private leave = () => this.dismiss(false);
  clear = () => this.dismiss(true);
  private dismiss(immediate: boolean) {
    this.pressed = undefined;
    this.hide(this.overlay, immediate);
    if (this.hovered) {
      this.hovered = undefined;
      this.onHover(null);
    }
    this.paintReadingFocus();
  }
  private press = (event: PointerEvent) => {
    this.pressed = undefined;
    if (
      (event.target as Element)?.closest(blockActionTarget) ||
      event.button !== 0
    )
      return;
    const block = this.find(event);
    if (block)
      this.pressed = { id: block.id, x: event.clientX, y: event.clientY };
  };
  private click = (event: MouseEvent) => {
    if ((event.target as Element)?.closest(blockActionTarget)) return;
    const pressed = this.pressed;
    this.pressed = undefined;
    // The annotation listener runs first on this host and claims marked text.
    if (
      event.defaultPrevented ||
      !pressed ||
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5 ||
      window.getSelection()?.toString().trim()
    )
      return;
    const block = this.find(event);
    if (!block || block.id !== pressed.id) return;
    if ((event.target as Element)?.closest("a, button, input, [role=button]"))
      return;
    if (this.onFocus(block)) {
      if (block.id === this.tourTarget.dataset.blockId)
        this.tourTarget.dataset.demonstrated = "true";
      event.preventDefault();
      event.stopPropagation();
      this.clear();
      return;
    }
    if (!block.image) return;
    event.preventDefault();
    event.stopPropagation();
    this.onAction(block, "attach");
  };
  private find(event: MouseEvent) {
    const page = (event.target as Element | null)?.closest<HTMLElement>(
      ".page[data-page-number]",
    );
    if (!page || !this.host.contains(page)) return;
    const rect = page.getBoundingClientRect();
    return hitBlock(
      this.blocks,
      Number(page.dataset.pageNumber),
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
  }
  private move = (event: PointerEvent) => {
    if ((event.target as Element | null)?.closest(blockActionTarget)) return;
    if (event.buttons || window.getSelection()?.toString().trim()) {
      this.clear();
      return;
    }
    const page = (event.target as Element | null)?.closest<HTMLElement>(
      ".page[data-page-number]",
    );
    if (!page || !this.host.contains(page)) {
      this.leave();
      return;
    }
    const rect = page.getBoundingClientRect();
    const block = hitBlock(
      this.blocks,
      Number(page.dataset.pageNumber),
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
    if (!block) {
      this.leave();
      return;
    }
    if (this.active !== block) {
      this.active = block;
      this.root.render(
        createElement(BlockActions<PDFBlock>, {
          block,
          onAction: this.onAction,
        }),
      );
    }
    const b = block.bounds;
    Object.assign(this.overlay.style, {
      left: `${b.x * 100}%`,
      top: `${b.y * 100}%`,
      width: `${b.width * 100}%`,
      height: `${b.height * 100}%`,
    });
    this.overlay.dataset.blockId = block.id;
    this.overlay.dataset.blockKind = block.image ? "image" : "text";
    this.show(this.overlay, page);
    if (this.hovered !== block.id) {
      this.hovered = block.id;
      this.onHover(block);
    }
    this.paintReadingFocus();
  };
  setLinkedBlock(blockId: string | null) {
    if (this.linkedId === blockId) return;
    this.linkedId = blockId;
    this.repaint();
  }
  setFocusBlock(blockId: string | null) {
    this.focusId = blockId;
    this.tourTarget.dataset.focused = String(
      blockId === this.tourTarget.dataset.blockId,
    );
    if (!blockId) {
      if (reducedMotion()) this.focus.remove();
      else this.focus.dataset.fading = "";
      return;
    }
    delete this.focus.dataset.fading;
    this.paintReadingFocus();
  }
  flashBlock(blockId: string) {
    clearTimeout(this.referenceFlashTimer);
    this.referenceFlashId = blockId;
    this.paintReferenceFlash();
    this.referenceFlashTimer = setTimeout(() => {
      this.referenceFlashId = null;
      this.referenceFlash.remove();
      this.referenceFlashTimer = undefined;
    }, 1000);
  }
  private paintReferenceFlash() {
    const block = this.blocks.find((b) => b.id === this.referenceFlashId);
    const page =
      block &&
      this.host.querySelector<HTMLElement>(
        `.page[data-page-number="${block.page}"]`,
      );
    if (!block || !page) {
      this.referenceFlash.remove();
      return;
    }
    const b = block.bounds;
    Object.assign(this.referenceFlash.style, {
      left: `${b.x * 100}%`,
      top: `${b.y * 100}%`,
      width: `${b.width * 100}%`,
      height: `${b.height * 100}%`,
    });
    this.referenceFlash.dataset.blockId = block.id;
    if (this.referenceFlash.parentElement !== page)
      page.append(this.referenceFlash);
  }
  private paintReadingFocus() {
    if (!this.focusId) return;
    this.focus.remove();
    if (this.focusId === this.hovered || this.focusId === this.linkedId) return;
    const block = this.blocks.find((b) => b.id === this.focusId);
    if (!block) return;
    const page = this.host.querySelector<HTMLElement>(
      `.page[data-page-number="${block.page}"]`,
    );
    if (!page) return;
    const b = block.bounds;
    Object.assign(this.focus.style, {
      left: `${b.x * 100}%`,
      top: `${b.y * 100}%`,
      width: `${b.width * 100}%`,
      height: `${b.height * 100}%`,
    });
    this.focus.dataset.blockId = block.id;
    this.focus.dataset.blockKind = block.image ? "image" : "text";
    page.append(this.focus);
  }
  private paintTourTarget() {
    // Prefer a full paragraph over the title or author list.
    const text = this.blocks.filter((b) => !b.image && b.text.trim());
    const block =
      text.find((b) => b.label === "text" && b.text.length > 100) ?? text[0];
    const page =
      block &&
      this.host.querySelector<HTMLElement>(
        `.page[data-page-number="${block.page}"]`,
      );
    if (!block || !page) {
      this.tourTarget.remove();
      return;
    }
    const b = block.bounds;
    Object.assign(this.tourTarget.style, {
      left: `${b.x * 100}%`,
      top: `${b.y * 100}%`,
      width: `${b.width * 100}%`,
      height: `${b.height * 100}%`,
    });
    this.tourTarget.dataset.blockId = block.id;
    this.tourTarget.dataset.focused = String(this.focusId === block.id);
    if (this.tourTarget.parentElement !== page) page.append(this.tourTarget);
  }
  repaint() {
    this.paintTourTarget();
    this.paintReferenceFlash();
    for (const [id, element] of this.searchBlocks) {
      const match = this.blocks.find((block) => block.id === id);
      const page =
        match &&
        this.host.querySelector<HTMLElement>(
          `.page[data-page-number="${match.page}"]`,
        );
      if (!match || !page) {
        element.remove();
        continue;
      }
      const b = match.bounds;
      Object.assign(element.style, {
        left: `${b.x * 100}%`,
        top: `${b.y * 100}%`,
        width: `${b.width * 100}%`,
        height: `${b.height * 100}%`,
      });
      if (element.parentElement !== page) page.append(element);
    }
    this.paintReadingFocus();
    const block = this.blocks.find((b) => b.id === this.linkedId);
    if (!block) {
      this.hide(this.linked);
      return;
    }
    const page = this.host.querySelector<HTMLElement>(
      `.page[data-page-number="${block.page}"]`,
    );
    if (!page) return;
    const b = block.bounds;
    Object.assign(this.linked.style, {
      left: `${b.x * 100}%`,
      top: `${b.y * 100}%`,
      width: `${b.width * 100}%`,
      height: `${b.height * 100}%`,
    });
    this.linked.dataset.blockId = block.id;
    this.linked.dataset.blockKind = block.image ? "image" : "text";
    this.show(this.linked, page);
  }
  destroy() {
    this.tourTarget.remove();
    this.tourTarget.onclick = null;
    clearTimeout(this.referenceFlashTimer);
    this.referenceFlash.remove();
    for (const element of this.searchBlocks.values()) element.remove();
    this.searchBlocks.clear();
    this.focusId = null;
    this.focus.remove();
    this.clear();
    this.hide(this.linked, true);
    this.fades.forEach((a) => a.cancel());
    this.fades.clear();
    this.root.unmount();
    this.host.removeEventListener("pointermove", this.move);
    this.host.removeEventListener("pointerleave", this.leave);
    this.host.removeEventListener("pointerdown", this.press);
    this.host.removeEventListener("click", this.click, true);
    this.host.removeEventListener("pointerup", this.move);
    this.host.removeEventListener("scroll", this.clear);
  }
}
