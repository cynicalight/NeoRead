import { useEffect, useState } from "react";
import type { ReaderSelection } from "@neoread/core";
import { api } from "@neoread/api";
import { Popover, PopoverContent } from "@neoread/ui/components/popover";
import type { SelectionTranslationAnchor } from "./selection-translation-anchor";

export function SelectionTranslation({
  selection,
  onClose,
  trackedAnchor,
}: {
  selection: ReaderSelection | null;
  onClose: () => void;
  trackedAnchor?: SelectionTranslationAnchor;
}) {
  const [, refreshAnchor] = useState(0);
  useEffect(() => {
    if (!selection) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => refreshAnchor((value) => value + 1));
    };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [selection]);
  const [result, setResult] = useState<{
    selection: ReaderSelection;
    text?: string;
    error?: string;
  }>();
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    setResult({ selection });
    void api.translateSelection(selection, controller.signal).then(
      ({ text }) => {
        if (!controller.signal.aborted) setResult({ selection, text });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            selection,
            error: error instanceof Error ? error.message : "翻译失败，请重试",
          });
      },
    );
    return () => controller.abort();
  }, [selection]);
  useEffect(() => {
    if (!selection) return;
    const interrupt = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-selection-translation]")
      )
        return;
      onClose();
    };
    window.addEventListener("pointerdown", interrupt, true);
    return () => {
      window.removeEventListener("pointerdown", interrupt, true);
    };
  }, [selection, onClose]);
  const current = result?.selection === selection ? result : undefined;
  const anchor = selection?.anchor;
  return (
    <Popover
      open={!!anchor}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {anchor && (
        <PopoverContent
          anchor={{
            contextElement: trackedAnchor?.contextElement,
            getBoundingClientRect: () =>
              trackedAnchor?.getBoundingClientRect() ??
              new DOMRect(
                anchor.x,
                anchor.top,
                1,
                Math.max(1, anchor.bottom - anchor.top),
              ),
          }}
          collisionBoundary={trackedAnchor?.boundary}
          style={
            trackedAnchor
              ? {
                  maxWidth: Math.max(
                    1,
                    Math.min(
                      320,
                      trackedAnchor.boundary.getBoundingClientRect().width - 16,
                    ),
                  ),
                  maxHeight: Math.max(
                    1,
                    Math.min(
                      384,
                      trackedAnchor.boundary.getBoundingClientRect().height -
                        16,
                    ),
                  ),
                }
              : undefined
          }
          side="right"
          align="start"
          sideOffset={12}
          finalFocus={false}
          aria-label="翻译"
          data-selection-translation=""
          className="max-h-[min(24rem,70vh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <div
            role="status"
            aria-live="polite"
            className="whitespace-pre-wrap break-words text-sm leading-relaxed"
          >
            {current?.error || current?.text || "正在翻译…"}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
