import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  Annotation,
  ReaderAnnotationTarget,
  SelectionAnchor,
} from "@neoread/core";
import { Check, GripVertical, Pencil, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
} from "@neoread/ui/components/popover";
import { Textarea } from "@neoread/ui/components/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";

/** Adds or edits a note/question inside the annotation card. */
export interface AnnotationNoteEditor {
  anchor: SelectionAnchor;
  kind: "note" | "question";
  /** Whether an existing annotation is being edited. */
  editing: boolean;
  /** Text when the editor opened; an emptied note may still be saved. */
  initial: string;
  value: string;
  saving: boolean;
  canAnswer: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onSaveAndAnswer: () => void;
  onClose: () => void;
}

const anchorKey = (anchor?: SelectionAnchor) =>
  anchor ? `${anchor.x}:${anchor.top}:${anchor.bottom}` : "";

function CardButton({
  label,
  children,
  variant = "ghost",
  disabled,
  onClick,
  onPointerDown,
  className,
}: {
  label: string;
  children: ReactNode;
  variant?: "ghost" | "default";
  disabled?: boolean;
  onClick?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant={variant}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            onPointerDown={onPointerDown}
            className={className}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// One floating card previews, adds, edits and deletes notes on a highlight.
export function AnnotationHoverCard({
  target,
  annotations,
  editor,
  onEdit,
  onDelete,
}: {
  target: ReaderAnnotationTarget | null;
  annotations: Annotation[];
  editor?: AnnotationNoteEditor | null;
  onEdit: (annotation: Annotation, anchor: SelectionAnchor) => void;
  onDelete: (annotation: Annotation) => void;
}) {
  const [shown, setShown] = useState<ReaderAnnotationTarget | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inside = useRef(false);
  // A card moved by the user stays until dismissed, not until pointer leave.
  const pinned = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const cancel = () => clearTimeout(timer.current);
  const close = () => {
    cancel();
    inside.current = false;
    pinned.current = false;
    setShown(null);
  };
  const leave = () => {
    cancel();
    if (pinned.current) return;
    timer.current = setTimeout(() => setShown(null), 250);
  };
  useEffect(() => {
    cancel();
    if (target) {
      timer.current = setTimeout(() => setShown(target), 50);
    } else if (!inside.current) leave();
    return cancel;
  }, [target]);
  useEffect(() => {
    const interrupt = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-annotation-preview]")
      )
        return;
      close();
    };
    window.addEventListener("scroll", interrupt, true);
    window.addEventListener("resize", interrupt);
    return () => {
      cancel();
      window.removeEventListener("scroll", interrupt, true);
      window.removeEventListener("resize", interrupt);
    };
  }, []);
  const editing = !!editor;
  useEffect(() => {
    if (editing) input.current?.focus({ preventScroll: true });
  }, [editing]);
  const anchor = editor?.anchor ?? shown?.anchor;
  const key = anchorKey(anchor);
  // Keep the drag offset while a preview turns into its editor.
  const [placed, setPlaced] = useState(key);
  if (placed !== key) {
    setPlaced(key);
    setOffset({ x: 0, y: 0 });
  }
  const notes =
    !editor && shown
      ? annotations.filter((a) => shown.ids.includes(a.id) && a.note.trim())
      : [];
  const open = !!editor || notes.length > 0;

  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const start = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    pinned.current = true;
    cancel();
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) =>
      setOffset({ x: next.clientX - start.x, y: next.clientY - start.y });
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const grip = (
    <CardButton
      label="拖动"
      onPointerDown={drag}
      className="cursor-grab touch-none active:cursor-grabbing"
    >
      <GripVertical className="size-3.5" />
    </CardButton>
  );

  const canSave =
    !!editor &&
    !editor.saving &&
    (editor.kind === "question"
      ? !!editor.value.trim()
      : !!editor.value.trim() || !!editor.initial.trim());
  const title = editor
    ? editor.kind === "question"
      ? editor.editing
        ? "编辑问题"
        : "提问"
      : editor.initial.trim()
        ? "编辑批注"
        : "添加批注"
    : "批注";

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (!editor) {
          close();
          return;
        }
        if (editor.saving) return;
        // A stray click in the page must not discard a typed draft.
        if (
          editor.value !== editor.initial &&
          editor.value.trim() &&
          details.reason !== "escape-key"
        )
          return;
        pinned.current = false;
        editor.onClose();
      }}
    >
      {open && anchor && (
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
          initialFocus={editor ? input : false}
          finalFocus={false}
          style={{ translate: `${offset.x}px ${offset.y}px` }}
          className="max-h-[min(24rem,70vh)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
          data-annotation-preview=""
          onPointerEnter={() => {
            inside.current = true;
            cancel();
          }}
          onPointerLeave={() => {
            inside.current = false;
            if (!editor) leave();
          }}
          onFocusCapture={() => {
            inside.current = true;
            cancel();
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              inside.current = false;
              if (!editor) leave();
            }
          }}
        >
          <PopoverTitle className="sr-only">{title}</PopoverTitle>
          {editor ? (
            <>
              <Textarea
                ref={input}
                aria-label={title}
                placeholder={
                  editor.kind === "question" ? "想弄清楚什么？" : "批注内容…"
                }
                className="max-h-[min(16rem,45vh)] min-h-20 resize-none"
                value={editor.value}
                onChange={(e) => editor.onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.metaKey || e.ctrlKey) &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if (canSave) editor.onSave();
                  }
                }}
              />
              <div className="flex items-center gap-1">
                {grip}
                <div className="ml-auto flex gap-1">
                  {editor.kind === "question" && !editor.editing && (
                    <CardButton
                      label="保存并让 AI 回答"
                      disabled={!canSave || !editor.canAnswer}
                      onClick={editor.onSaveAndAnswer}
                    >
                      <Sparkles className="size-3.5" />
                    </CardButton>
                  )}
                  <CardButton
                    label="保存"
                    variant="default"
                    disabled={!canSave}
                    onClick={editor.onSave}
                  >
                    <Check className="size-3.5" />
                  </CardButton>
                </div>
              </div>
            </>
          ) : (
            shown &&
            notes.map((annotation, index) => (
              <div
                key={annotation.id}
                className="border-b pb-2 last:border-0 last:pb-0"
              >
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {annotation.note}
                </p>
                <div className="mt-1 flex items-center gap-1">
                  {index === 0 && grip}
                  <div className="ml-auto flex gap-1">
                    <CardButton
                      label="编辑批注"
                      onClick={() => {
                        cancel();
                        inside.current = false;
                        setShown(null);
                        onEdit(annotation, shown.anchor);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </CardButton>
                    <CardButton
                      label="删除批注"
                      onClick={() => onDelete(annotation)}
                    >
                      <Trash2 className="size-3.5" />
                    </CardButton>
                  </div>
                </div>
              </div>
            ))
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}
