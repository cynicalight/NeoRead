import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";

const threshold = 5;
const edge = 36;
const settle = 160;

const reducedMotion = () =>
  !window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches;

/**
 * Pointer reordering for a horizontal tab strip: the pressed tab follows the
 * pointer, neighbours slide out of its way, and the strip scrolls near its
 * edges. The new order is committed once the tab has settled into its slot.
 */
export function useTabReorder(
  strip: RefObject<HTMLElement | null>,
  onMove: (id: string, index: number) => void,
) {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return (id: string) => (event: PointerEvent<HTMLElement>) => {
    const container = strip.current;
    if (
      event.button !== 0 ||
      !container ||
      stop.current ||
      (event.target as Element).closest(".document-tab-close")
    )
      return;
    const startX = event.clientX,
      startScroll = container.scrollLeft;
    let pointerX = startX;
    let tabs: HTMLElement[] = [];
    let from = -1,
      to = -1,
      offsets: number[] = [],
      frame = 0;
    const layout = () =>
      tabs.map((tab) => ({ left: tab.offsetLeft, width: tab.offsetWidth }));
    let rects: ReturnType<typeof layout> = [],
      gap = 0;
    const place = () => {
      const r = rects[from];
      const dx = Math.max(
        rects[0].left - r.left,
        Math.min(
          rects[rects.length - 1].left +
            rects[rects.length - 1].width -
            r.left -
            r.width,
          pointerX - startX + container.scrollLeft - startScroll,
        ),
      );
      const center = r.left + r.width / 2 + dx;
      to = from;
      offsets = rects.map((rect, i) => {
        if (i === from) return dx;
        const middle = rect.left + rect.width / 2;
        if (i < from && center < middle) {
          to--;
          return r.width + gap;
        }
        if (i > from && center > middle) {
          to++;
          return -(r.width + gap);
        }
        return 0;
      });
      tabs.forEach((tab, i) => {
        tab.style.transform = offsets[i] ? `translateX(${offsets[i]}px)` : "";
      });
    };
    const scroll = () => {
      const bounds = container.getBoundingClientRect();
      const speed =
        pointerX < bounds.left + edge
          ? -Math.ceil((bounds.left + edge - pointerX) / 4)
          : pointerX > bounds.right - edge
            ? Math.ceil((pointerX - bounds.right + edge) / 4)
            : 0;
      if (speed) {
        container.scrollLeft += speed;
        place();
      }
      frame = requestAnimationFrame(scroll);
    };
    const start = () => {
      tabs = [
        ...container.querySelectorAll<HTMLElement>(
          ".document-tab:not([data-leaving])",
        ),
      ];
      from = tabs.findIndex((tab) => tab.dataset.tabId === id);
      if (from < 0) return false;
      rects = layout();
      gap =
        rects.length > 1 ? rects[1].left - rects[0].left - rects[0].width : 0;
      container.dataset.dragging = "";
      tabs[from].dataset.dragging = "";
      frame = requestAnimationFrame(scroll);
      return true;
    };
    let dragging = false;
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      pointerX = e.clientX;
      if (!dragging) {
        if (Math.abs(pointerX - startX) < threshold) return;
        dragging = start();
        if (!dragging) return finish();
        getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      place();
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      for (const tab of tabs) {
        tab.style.transition = "none";
        tab.style.transform = "";
        delete tab.dataset.dragging;
      }
      delete container.dataset.dragging;
      void container.offsetWidth;
      for (const tab of tabs) tab.style.transition = "";
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", cancel);
      stop.current = null;
    };
    const cancel = () => {
      finish();
      if (dragging) reset();
    };
    const drop = () => {
      finish();
      if (!dragging) return;
      cancelAnimationFrame(frame);
      const dragged = tabs[from];
      // The slot is where the neighbours that moved aside left a gap.
      const slot = offsets.reduce(
        (sum, offset, i) =>
          i === from || !offset
            ? sum
            : sum - Math.sign(offset) * (rects[i].width + gap),
        0,
      );
      const commit = () => {
        flushSync(() => onMove(id, to));
        reset();
      };
      if (reducedMotion()) return commit();
      dragged.style.transition = `transform ${settle}ms ease-out`;
      dragged.style.transform = `translateX(${slot}px)`;
      stop.current = commit;
      setTimeout(() => {
        if (stop.current !== commit) return;
        stop.current = null;
        commit();
      }, settle);
    };
    stop.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", cancel);
  };
}
