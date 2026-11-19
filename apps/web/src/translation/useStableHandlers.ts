import { useRef, useState } from "react";

type Handlers = Record<string, (...args: never[]) => unknown>;

/**
 * Handlers whose identities never change but which always call the latest
 * render's versions, so memoized rows can receive them without re-rendering.
 * The set of keys is fixed by the first render.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [stable] = useState(() => {
    const forwarded: Handlers = {};
    for (const key of Object.keys(handlers))
      forwarded[key] = (...args) => latest.current[key](...args);
    // Each forwarder has its handler's signature; the record type cannot say so.
    return forwarded as T;
  });
  return stable;
}
