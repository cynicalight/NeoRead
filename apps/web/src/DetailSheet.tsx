import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Sheet, SheetContent } from "@neoread/ui/components/sheet";
import {
  clampDetailWidth,
  detailWidthRange,
  dragHorizontally,
  resizeStep,
} from "./papers/resize";

/**
 * How long a lone click waits before changing the detail sheet. A second
 * click inside it makes a double click, which opens the item instead.
 */
export const doubleClickWindow = 300;

/**
 * Holds a click's detail change until it cannot become a double click, like
 * Finder and Drive: the item highlights at once, the sheet follows only for a
 * single click, so double-clicking opens without the sheet flashing first.
 * A later key press or selection change (`current`) overrides the held click.
 */
export function useClickIntent(current: string | null | undefined) {
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    setPending(null);
  }, []);
  useEffect(cancel, [current, cancel]);
  useEffect(() => {
    if (!pending) return;
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [pending, cancel]);
  const defer = useCallback((id: string, run: () => void) => {
    window.clearTimeout(timer.current);
    setPending(id);
    timer.current = window.setTimeout(() => {
      setPending(null);
      run();
    }, doubleClickWindow);
  }, []);
  return { pending, defer, cancel };
}

/**
 * Library details float over the list in a non-modal sheet: opening one never
 * reflows the list, and rows stay clickable to switch the item shown.
 */
export function DetailSheet({
  open,
  onClose,
  container,
  label,
  width,
  saveWidth,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The library body the sheet floats over. */
  container: HTMLElement | null;
  label: string;
  width?: number;
  saveWidth: (width: number) => void;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<number>();
  // The closing animation keeps showing the item that was open.
  const shown = useRef<ReactNode>(null);
  if (open) shown.current = children;
  const current = draft ?? width;
  const resize = (e: ReactPointerEvent<HTMLElement>) => {
    const start =
      e.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    let next: number | undefined;
    dragHorizontally(
      e,
      // The sheet sits on the right: dragging left widens it.
      (dx) => setDraft((next = clampDetailWidth(start - dx))),
      () => {
        if (next !== undefined) saveWidth(next);
        setDraft(undefined);
      },
    );
  };
  const nudge = (e: ReactKeyboardEvent<HTMLElement>) => {
    const dx = { ArrowLeft: resizeStep, ArrowRight: -resizeStep }[e.key];
    if (!dx) return;
    e.preventDefault();
    const start =
      e.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    saveWidth(clampDetailWidth(start + dx));
  };
  if (!container) return null;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      modal={false}
      disablePointerDismissal
    >
      <SheetContent
        container={container}
        showOverlay={false}
        // Focus stays in the list so arrow keys keep moving between items.
        initialFocus={false}
        finalFocus={false}
        aria-label={label}
        data-neoread-library-detail=""
        className="detail-sheet"
        style={
          current
            ? ({ "--paper-detail-width": `${current}px` } as CSSProperties)
            : undefined
        }
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`调整${label}宽度`}
          aria-valuemin={detailWidthRange.min}
          aria-valuemax={detailWidthRange.max}
          aria-valuenow={current}
          tabIndex={0}
          className="paper-detail-resizer"
          onPointerDown={resize}
          onKeyDown={nudge}
        />
        {shown.current}
      </SheetContent>
    </Sheet>
  );
}
