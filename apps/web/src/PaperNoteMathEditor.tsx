import { lazy, Suspense, useRef, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Textarea } from "@neoread/ui/components/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
} from "@neoread/ui/components/popover";
import type { MathEditRequest } from "./paper-note-math";

const MathFormula = lazy(() => import("./chat/MathFormula"));

export function PaperNoteMathEditor({
  request,
  onClose,
}: {
  request: MathEditRequest;
  onClose: () => void;
}) {
  const [value, setValue] = useState(request.value);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const close = () => {
    request.finish();
    onClose();
  };
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <PopoverContent
        anchor={request.anchor}
        side="bottom"
        align="start"
        initialFocus={input}
        finalFocus={() =>
          request.focusTarget.isConnected ? request.focusTarget : false
        }
        className="w-80 max-w-[calc(100vw-2rem)]"
        data-note-math-editor=""
        data-annotation-preview=""
        onKeyDown={(event) => {
          // Keep formula input inside its editor, including nested annotation cards.
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Escape" ||
            (event.key === "Enter" &&
              !event.shiftKey &&
              (!request.display || event.metaKey || event.ctrlKey))
          ) {
            event.preventDefault();
            close();
          }
        }}
      >
        <PopoverTitle>编辑公式</PopoverTitle>
        <Textarea
          ref={input}
          aria-label="LaTeX 公式"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            if (!request.update(next))
              setError("公式已发生变化，请重新打开编辑。");
          }}
          className="max-h-48 min-h-20 resize-none font-mono text-sm"
        />
        <div
          className="max-h-48 overflow-auto"
          aria-label="公式预览"
          role="img"
        >
          <Suspense fallback={null}>
            <MathFormula value={value} display={request.display} />
          </Suspense>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button size="xs" className="self-end" onClick={close}>
          完成
        </Button>
      </PopoverContent>
    </Popover>
  );
}
