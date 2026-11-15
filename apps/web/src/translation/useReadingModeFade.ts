import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent,
  type RefObject,
} from "react";

export function useReadingModeFade(
  root: RefObject<HTMLElement | null>,
  active: boolean,
) {
  const phase = useRef<"pointer" | "restore" | undefined>(undefined);
  const animation = useRef<Animation | undefined>(undefined);
  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)"),
    [],
  );
  const cancel = () => {
    phase.current = undefined;
    const previous = animation.current;
    animation.current = undefined;
    previous?.cancel();
  };
  const enter = (outgoing: Animation) => {
    if (animation.current !== outgoing) return;
    const content =
      root.current?.querySelector<HTMLElement>(".translation-panes");
    if (!content || reducedMotion.matches) {
      cancel();
      return;
    }
    const incoming = content.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: 100,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    animation.current = incoming;
    outgoing.cancel();
    incoming.onfinish = () => {
      if (animation.current === incoming) animation.current = undefined;
    };
  };
  const begin = (next: "pointer" | "restore") => {
    const content =
      root.current?.querySelector<HTMLElement>(".translation-panes");
    if (!active || reducedMotion.matches || !content?.animate) return;
    const opacity = getComputedStyle(content).opacity;
    cancel();
    phase.current = next;
    const outgoing = content.animate([{ opacity }, { opacity: 0.35 }], {
      duration: 40,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      fill: "forwards",
    });
    animation.current = outgoing;
    outgoing.onfinish = () => {
      if (animation.current === outgoing && phase.current === "pointer") {
        phase.current = undefined;
        enter(outgoing);
      }
    };
  };

  useLayoutEffect(() => {
    if (!active) cancel();
    return cancel;
  }, [active]);

  useEffect(() => {
    reducedMotion.addEventListener("change", cancel);
    return () => {
      reducedMotion.removeEventListener("change", cancel);
      cancel();
    };
  }, [reducedMotion]);

  return {
    onPointerDownCapture(event: PointerEvent<HTMLElement>) {
      const tab = (event.target as Element).closest('[role="tab"]');
      if (tab?.getAttribute("aria-selected") === "false") begin("pointer");
    },
    prepare(event: { type: string; detail?: number }) {
      const pointer =
        event.type === "pointerdown" ||
        event.type === "mousedown" ||
        event.type === "touchend" ||
        (event.type === "click" && (event.detail ?? 0) > 0);
      if (!pointer || !active || reducedMotion.matches) {
        cancel();
      } else if (phase.current === "pointer") {
        phase.current = "restore";
      } else {
        begin("restore");
      }
    },
    reveal() {
      if (phase.current !== "restore") return;
      phase.current = undefined;
      const outgoing = animation.current;
      if (!outgoing) return;
      if (outgoing.playState === "finished") enter(outgoing);
      else outgoing.onfinish = () => enter(outgoing);
    },
  };
}
