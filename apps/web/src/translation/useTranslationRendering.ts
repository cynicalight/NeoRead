import { useLayoutEffect, useRef } from "react";

/** Let Chromium skip distant blocks, while navigation measures its one target
 * with real text/formula geometry rather than the offscreen size estimate.
 */
export function useTranslationRendering(
  documentId: string,
  mode: string,
  invalidate?: () => void,
) {
  const target = useRef<HTMLElement | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      target.current?.removeAttribute("data-translation-render-target");
      target.current = undefined;
    },
    [documentId, mode],
  );
  return (node: HTMLElement | undefined) => {
    if (target.current !== node) {
      target.current?.removeAttribute("data-translation-render-target");
      target.current = node;
      node?.setAttribute("data-translation-render-target", "");
      invalidate?.();
    }
    return node;
  };
}
