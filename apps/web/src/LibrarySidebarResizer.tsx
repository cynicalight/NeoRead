import { useLayoutEffect, useRef } from "react";
import { Button } from "@neoread/ui/components/button";
import { useReaderStore } from "./store";
import { dragHorizontally, resizeStep } from "./papers/resize";

const limits = { min: 208, max: 420 };
const clamp = (width: number) =>
  Math.round(Math.max(limits.min, Math.min(limits.max, width)));

/** The library keeps its floating main panel while its sidebar boundary moves. */
export function LibrarySidebarResizer() {
  const saved = useReaderStore((state) => state.theme.librarySidebarWidth);
  const handle = useRef<HTMLButtonElement>(null);
  const current = useRef(238);
  const endDrag = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => () => endDrag.current?.(), []);
  const resize = (width: number) => {
    current.current = clamp(width);
    handle.current?.setAttribute("aria-valuenow", String(current.current));
    handle.current?.parentElement?.style.setProperty(
      "--library-sidebar-width",
      `${current.current}px`,
    );
  };
  useLayoutEffect(() => {
    if (typeof saved === "number" && Number.isFinite(saved)) resize(saved);
  }, [saved]);
  const save = () =>
    useReaderStore
      .getState()
      .setTheme({ librarySidebarWidth: current.current });
  const measure = () =>
    (
      handle.current?.previousElementSibling as HTMLElement | null
    )?.getBoundingClientRect().width || current.current;
  return (
    <Button
      ref={handle}
      variant="ghost"
      role="separator"
      aria-label="调整书库侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={typeof saved === "number" ? clamp(saved) : current.current}
      className="library-sidebar-resizer"
      onPointerDown={(event) => {
        endDrag.current?.();
        const start = measure();
        resize(start);
        endDrag.current = dragHorizontally(
          event,
          (dx) => resize(start + dx),
          () => {
            endDrag.current = undefined;
            save();
          },
        );
      }}
      onKeyDown={(event) => {
        const width = measure();
        const next =
          event.key === "ArrowLeft"
            ? width - resizeStep
            : event.key === "ArrowRight"
              ? width + resizeStep
              : event.key === "Home"
                ? limits.min
                : event.key === "End"
                  ? limits.max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        resize(next);
        save();
      }}
    />
  );
}
