import type { SelectionAnchor } from "@neoread/core";

export function captureSelectionTranslationAnchor(
  anchor: SelectionAnchor,
  pane: HTMLElement,
) {
  const selection = pane.ownerDocument.getSelection();
  const live = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  const range =
    live && !live.collapsed && pane.contains(live.commonAncestorContainer)
      ? live.cloneRange()
      : undefined;
  const element =
    range?.startContainer instanceof Element
      ? range.startContainer
      : range?.startContainer.parentElement;
  const scroller =
    element?.closest<HTMLElement>(
      ".pdf-container, .translation-document, .epub-web-reader",
    ) ?? pane;
  const before = scroller.getBoundingClientRect();
  const left = scroller.scrollLeft,
    top = scroller.scrollTop;
  return {
    contextElement: element ?? scroller,
    boundary: pane,
    getBoundingClientRect() {
      const host = scroller.getBoundingClientRect(),
        outer = pane.getBoundingClientRect();
      const viewport = {
        left: Math.max(host.left, outer.left),
        top: Math.max(host.top, outer.top),
        right: Math.min(host.right, outer.right),
        bottom: Math.min(host.bottom, outer.bottom),
      };
      const measured =
        range &&
        !range.collapsed &&
        range.startContainer.isConnected &&
        range.toString().trim()
          ? range.getBoundingClientRect()
          : undefined;
      const visibleRange =
        measured && (measured.width || measured.height) ? measured : undefined;
      const dx = host.left - before.left - (scroller.scrollLeft - left),
        dy = host.top - before.top - (scroller.scrollTop - top);
      const x = visibleRange
        ? (visibleRange.left + visibleRange.right) / 2
        : anchor.x + dx;
      const y = visibleRange?.top ?? anchor.top + dy;
      const bottom = visibleRange?.bottom ?? anchor.bottom + dy;
      const clamp = (value: number, min: number, max: number) =>
        Math.max(min, Math.min(value, Math.max(min, max)));
      const start = clamp(y, viewport.top + 8, viewport.bottom - 8);
      return new DOMRect(
        clamp(x, viewport.left + 8, viewport.right - 8),
        start,
        1,
        Math.max(
          1,
          clamp(bottom, viewport.top + 8, viewport.bottom - 8) - start,
        ),
      );
    },
  };
}

export type SelectionTranslationAnchor = ReturnType<
  typeof captureSelectionTranslationAnchor
>;
