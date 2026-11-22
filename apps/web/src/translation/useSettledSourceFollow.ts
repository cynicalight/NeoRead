import { useLayoutEffect, useRef } from "react";

/** Keep progress live, but move the opposite pane only for the final viewport. */
export function useSettledSourceFollow(documentId: string | undefined) {
  const source = useRef<HTMLDivElement>(null);
  const scrolling = useRef<EventTarget | null>(null);
  const pending = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    const host = source.current;
    if (!documentId || !host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      scrolling.current = null;
      const follow = pending.current;
      pending.current = undefined;
      follow?.();
    };
    const scroll = (event: Event) => {
      scrolling.current = event.target;
      // The engine measures this viewport on the next frame. If scrollend
      // arrives first, that final anchor will follow immediately instead.
      pending.current = undefined;
      if (!("onscrollend" in host)) {
        clearTimeout(timer);
        timer = setTimeout(finish, 150);
      }
    };
    const end = (event: Event) => {
      if (scrolling.current === event.target) finish();
    };
    host.addEventListener("scroll", scroll, true);
    host.addEventListener("scrollend", end, true);
    return () => {
      host.removeEventListener("scroll", scroll, true);
      host.removeEventListener("scrollend", end, true);
      clearTimeout(timer);
      scrolling.current = null;
      pending.current = undefined;
    };
  }, [documentId]);
  return {
    source,
    follow(action: () => void) {
      if (scrolling.current) pending.current = action;
      else action();
    },
    cancel() {
      pending.current = undefined;
    },
  };
}
