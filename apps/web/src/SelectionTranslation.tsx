import { useEffect, useState } from "react";
import type { ReaderSelection } from "@reader/core";
import { api } from "@reader/api";
import { Popover, PopoverContent } from "@reader/ui/components/popover";

export function SelectionTranslation({
  selection,
  onClose,
}: {
  selection: ReaderSelection | null;
  onClose: () => void;
}) {
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
    window.addEventListener("scroll", interrupt, true);
    window.addEventListener("resize", interrupt);
    return () => {
      window.removeEventListener("scroll", interrupt, true);
      window.removeEventListener("resize", interrupt);
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
            getBoundingClientRect: () =>
              new DOMRect(
                anchor.x,
                anchor.top,
                1,
                Math.max(1, anchor.bottom - anchor.top),
              ),
          }}
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
