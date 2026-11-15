import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import type { ReadingMode } from "./reading-mode";

export function useReadingModeFade(
  root: RefObject<HTMLElement | null>,
  mode: ReadingMode,
  active: boolean,
) {
  const pending = useRef(false);
  const animation = useRef<Animation | undefined>(undefined);
  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)"),
    [],
  );

  useLayoutEffect(() => {
    if (!active) pending.current = false;
    return () => {
      animation.current?.cancel();
    };
  }, [mode, active]);

  useEffect(() => {
    const cancel = () => {
      pending.current = false;
      animation.current?.cancel();
    };
    reducedMotion.addEventListener("change", cancel);
    return () => {
      reducedMotion.removeEventListener("change", cancel);
      cancel();
    };
  }, [reducedMotion]);

  return {
    prepare(event: { type: string; detail?: number }) {
      animation.current?.cancel();
      pending.current =
        active &&
        !reducedMotion.matches &&
        (event.type === "pointerdown" ||
          event.type === "mousedown" ||
          event.type === "touchend" ||
          (event.type === "click" && (event.detail ?? 0) > 0));
    },
    reveal() {
      if (!pending.current) return;
      pending.current = false;
      if (reducedMotion.matches) return;
      const content =
        root.current?.querySelector<HTMLElement>(".translation-panes");
      animation.current = content?.animate?.(
        [{ opacity: 0.75 }, { opacity: 1 }],
        { duration: 120, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    },
  };
}
