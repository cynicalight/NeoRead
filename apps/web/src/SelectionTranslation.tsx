import { useEffect, useState } from "react";
import type { ReaderSelection } from "@reader/core";
import { api } from "@reader/api";
import { X } from "lucide-react";
import { Button } from "@reader/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
} from "@reader/ui/components/popover";

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
  const [attempt, setAttempt] = useState(0);
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
  }, [selection, attempt]);
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
          data-selection-translation=""
          className="max-h-[min(24rem,70vh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle>翻译</PopoverTitle>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="关闭翻译"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
          <div
            role="status"
            aria-live="polite"
            className="whitespace-pre-wrap break-words text-sm leading-relaxed"
          >
            {current?.error || current?.text || "正在翻译…"}
          </div>
          {current?.error && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              重试
            </Button>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}
