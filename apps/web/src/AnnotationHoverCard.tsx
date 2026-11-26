import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  Annotation,
  ReaderAnnotationTarget,
  ReaderTheme,
  SelectionAnchor,
} from "@neoread/core";
import { Check, GripVertical, Sparkles } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
} from "@neoread/ui/components/popover";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";
import { MessageMarkdown } from "./chat/MessageMarkdown";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";
import {
  noteAnchor,
  subscribeNoteAnchors,
  type NoteAnchorElement,
} from "./readers/note-anchors";

/** Adds or edits a note/question inside the annotation card. */
export interface AnnotationNoteEditor {
  anchor: SelectionAnchor;
  /** Document whose attachments receive pasted images. */
  documentId: string;
  /** The annotation being edited; its always-shown card hides meanwhile. */
  annotationId?: string;
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

/** Card top-left from the end of its annotation, and an optional resized box. */
export type AnnotationCardLayout = NonNullable<
  ReaderTheme["annotationCardLayouts"]
>[string];
type CardBox = { w: number; h: number };

const anchorKey = (anchor?: SelectionAnchor) =>
  anchor ? `${anchor.x}:${anchor.top}:${anchor.bottom}` : "";

const anchorRect = (anchor: SelectionAnchor) => ({
  getBoundingClientRect: () =>
    new DOMRect(
      anchor.x,
      anchor.top,
      1,
      Math.max(1, anchor.bottom - anchor.top),
    ),
});

// A remembered position is kept on screen by shifting, never by flipping sides.
const shiftOnly = {
  side: "shift",
  align: "shift",
  fallbackAxisSide: "none",
} as const;
// Cards pinned to a PDF marker stay at their page position, like page content.
const atMarker = {
  side: "none",
  align: "none",
  fallbackAxisSide: "none",
} as const;

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

/**
 * Where a card opens: card units from a live marker element (it then follows
 * scrolling in step with the page), a top-left `point`, or beside a hovered
 * highlight.
 */
type Placement =
  | { element: NoteAnchorElement; x: number; y: number }
  | { point: { left: number; top: number } }
  | { beside: SelectionAnchor };

const interactive = (target: EventTarget) =>
  target instanceof Element && !!target.closest("a, button, img");

const MIN_BOX: CardBox = { w: 64, h: 16 };
// Edges and corners resize the card; its interior drags it.
const RESIZE_HANDLES = [
  ["n", "inset-x-2 top-0 h-1 cursor-ns-resize"],
  ["s", "inset-x-2 bottom-0 h-1 cursor-ns-resize"],
  ["e", "inset-y-2 right-0 w-1.5 cursor-ew-resize"],
  ["w", "inset-y-2 left-0 w-1.5 cursor-ew-resize"],
  ["nw", "top-0 left-0 size-2.5 cursor-nwse-resize"],
  ["se", "right-0 bottom-0 size-2.5 cursor-nwse-resize"],
  ["ne", "top-0 right-0 size-2.5 cursor-nesw-resize"],
  ["sw", "bottom-0 left-0 size-2.5 cursor-nesw-resize"],
] as const;

/**
 * Notes of one highlight, zoomed with the document. Pressing the interior
 * drags the card, edges resize it, and a double click edits the note under the
 * pointer. A resized card fits its text to the box.
 */
function NoteCard({
  notes,
  place,
  scale,
  size,
  container,
  opacity,
  dismissible,
  onEdit,
  onMoved,
  onDragStart,
  onDismiss,
  onPointerEnter,
  onPointerLeave,
}: {
  notes: Annotation[];
  place: Placement;
  /** CSS px per card unit. */
  scale: number;
  /** Remembered box in card units; otherwise the card fits its text. */
  size?: CardBox;
  /** Clips the card to the reader viewport; the body otherwise. */
  container?: HTMLElement;
  opacity: number;
  /** Hover cards close on outside press; always-shown cards stay. */
  dismissible: boolean;
  onEdit: (annotation: Annotation, card: DOMRect) => void;
  onMoved: (left: number, top: number, box?: CardBox) => void;
  /** A drag or resize began; hover cards then stay until dismissed. */
  onDragStart?: () => void;
  onDismiss?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const [delta, setDelta] = useState({ x: 0, y: 0 });
  // A drop keeps the card where it landed until the stored layout arrives.
  const [dropped, setDropped] = useState<{ left: number; top: number }>();
  const [resized, setResized] = useState<CardBox>();
  const element = "element" in place ? place : undefined;
  const point = dropped ?? ("point" in place ? place.point : undefined);
  const at =
    "point" in place
      ? { x: place.point.left, top: place.point.top, bottom: place.point.top }
      : "beside" in place
        ? place.beside
        : { x: place.x, top: place.y, bottom: place.y };
  const key = `${anchorKey(at)}:${scale}:${size?.w}:${size?.h}`;
  const [placed, setPlaced] = useState(key);
  if (placed !== key) {
    setPlaced(key);
    setDropped(undefined);
    setResized(undefined);
    setDelta({ x: 0, y: 0 });
  }
  const box = resized ?? size;
  const dragged = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  // The popup mounts after this component, so fit once its content exists.
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const text = notes.map((note) => note.note).join("\n");
  // The largest font whose wrapped text still fits the box.
  useLayoutEffect(() => {
    const element = content;
    if (!element) return;
    if (!box) {
      element.style.fontSize = "";
      return;
    }
    const fits = (font: number) => {
      element.style.fontSize = `${font}px`;
      return (
        element.scrollHeight <= element.clientHeight &&
        element.scrollWidth <= element.clientWidth
      );
    };
    let low = 6,
      high = 96;
    for (let step = 0; step < 10; step++) {
      const middle = (low + high) / 2;
      if (fits(middle)) low = middle;
      else high = middle;
    }
    element.style.fontSize = `${low}px`;
  }, [content, box?.w, box?.h, text]);

  const press = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || interactive(event.target)) return;
    // Dragging replaces text selection in the card; editing still allows it.
    event.preventDefault();
    const card = event.currentTarget;
    const edge =
      (event.target instanceof Element &&
        event.target.closest<HTMLElement>("[data-resize]")?.dataset.resize) ||
      "";
    const origin = { x: event.clientX, y: event.clientY };
    const start = card.getBoundingClientRect();
    const from = { w: start.width / scale, h: start.height / scale };
    let next: CardBox | undefined;
    dragged.current = false;
    const move = (pointer: PointerEvent) => {
      const x = pointer.clientX - origin.x,
        y = pointer.clientY - origin.y;
      // A press without movement stays a click, so double clicks reach the
      // note under the pointer instead of a captured card.
      if (!dragged.current) {
        if (Math.hypot(x, y) <= 3) return;
        dragged.current = true;
        card.setPointerCapture?.(pointer.pointerId);
        onDragStart?.();
      }
      if (!edge) {
        setDelta({ x, y });
        return;
      }
      let { w, h } = from,
        { left, top } = start;
      if (edge.includes("e")) w = Math.max(MIN_BOX.w, from.w + x / scale);
      if (edge.includes("w")) {
        w = Math.max(MIN_BOX.w, from.w - x / scale);
        left = start.right - w * scale;
      }
      if (edge.includes("s")) h = Math.max(MIN_BOX.h, from.h + y / scale);
      if (edge.includes("n")) {
        h = Math.max(MIN_BOX.h, from.h - y / scale);
        top = start.bottom - h * scale;
      }
      next = { w, h };
      setResized(next);
      if (element) setDelta({ x: left - start.left, y: top - start.top });
      else setDropped({ left, top });
    };
    const end = () => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", end);
      card.removeEventListener("pointercancel", end);
      if (!dragged.current) return;
      const rect = card.getBoundingClientRect();
      // Pinned cards keep their delta until the stored layout moves the
      // offsets; other cards re-anchor where they landed.
      if (!element) {
        setDropped({ left: rect.left, top: rect.top });
        setDelta({ x: 0, y: 0 });
      }
      onMoved(rect.left, rect.top, next);
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  };
  const click = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (event.detail !== 2 || interactive(event.target)) return;
    const id =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-note-id]")?.dataset.noteId
        : undefined;
    const annotation = notes.find((note) => note.id === id);
    if (annotation) onEdit(annotation, popup.current!.getBoundingClientRect());
  };
  const base = dropped
    ? { x: dropped.left, top: dropped.top, bottom: dropped.top }
    : at;

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (next) return;
        if (dismissible) onDismiss?.();
      }}
    >
      <PopoverContent
        ref={popup}
        container={container}
        // Drags move the anchor or its offsets, so positioning and zoom stay
        // in step.
        anchor={
          element
            ? element.element
            : anchorRect({
                x: base.x + delta.x,
                top: base.top + delta.y,
                bottom: base.bottom + delta.y,
              })
        }
        side="right"
        align="start"
        sideOffset={
          element ? element.x * scale + delta.x : point ? 0 : 12 * scale
        }
        alignOffset={element ? element.y * scale + delta.y : 0}
        collisionAvoidance={element ? atMarker : point ? shiftOnly : undefined}
        initialFocus={false}
        finalFocus={false}
        // `zoom` scales size, text and padding with the document.
        style={{ zoom: scale, opacity, width: box?.w, height: box?.h }}
        // The popup's transition duration would otherwise animate `width`,
        // `height`, `zoom` and position, lagging behind resizes and PDF zoom.
        // Pinned cards mount as their marker scrolls into view; an open
        // animation there reads as a pop-in instead of page content.
        className={`pointer-events-auto relative cursor-grab overflow-hidden px-1 py-0.5 transition-none select-none active:cursor-grabbing ${element ? "data-open:animate-none" : ""} ${box ? "" : "max-h-[min(30rem,80vh)] w-max max-w-[min(18rem,calc(100vw-2rem))]"}`}
        data-annotation-preview=""
        onPointerDown={press}
        onClick={click}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <PopoverTitle className="sr-only">批注</PopoverTitle>
        <div
          ref={setContent}
          // Safe centering splits leftover width and height evenly yet falls
          // back to the start on overflow, so the fit's scroll checks stay
          // accurate. The single grid column spans the widest note, keeping
          // separators equal.
          className={`min-h-0 flex-1 ${box ? "grid place-content-center-safe overflow-hidden [overflow-wrap:anywhere]" : "overflow-y-auto"}`}
        >
          {notes.map((annotation) => (
            <div
              key={annotation.id}
              data-note-id={annotation.id}
              className="border-b pb-2 last:border-0 last:pb-0"
            >
              <MessageMarkdown
                content={annotation.note}
                animated={false}
                literalHtml
                noteImages
              />
            </div>
          ))}
        </div>
        {RESIZE_HANDLES.map(([edge, position]) => (
          <div
            key={edge}
            aria-hidden="true"
            data-resize={edge}
            className={`absolute ${position}`}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

// Floating cards preview notes on highlights and edit them in place.
export function AnnotationHoverCard({
  target,
  annotations,
  editor,
  onEdit,
  alwaysShow = false,
  opacity = 0.9,
  layouts = {},
  onLayout,
}: {
  target: ReaderAnnotationTarget | null;
  annotations: Annotation[];
  editor?: AnnotationNoteEditor | null;
  onEdit: (annotation: Annotation, anchor: SelectionAnchor) => void;
  /** Show cards for every visible note without hovering. */
  alwaysShow?: boolean;
  opacity?: number;
  /** Remembered card layouts, relative to the end of each annotation. */
  layouts?: Record<string, AnnotationCardLayout>;
  onLayout?: (id: string, layout: AnnotationCardLayout) => void;
}) {
  const [shown, setShown] = useState<ReaderAnnotationTarget | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inside = useRef(false);
  // A dragged card stays until dismissed, not until pointer leave.
  const pinned = useRef(false);
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
    timer.current = setTimeout(() => setShown(null), 600);
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
  // Always-shown cards follow their annotations while reading scrolls.
  const [, setFrame] = useState(0);
  useEffect(() => {
    if (!alwaysShow) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setFrame((n) => n + 1));
    };
    const unsubscribe = subscribeNoteAnchors(update);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [alwaysShow]);

  const anchor = editor?.anchor;
  const key = anchorKey(anchor);
  const [placed, setPlaced] = useState(key);
  if (placed !== key) {
    setPlaced(key);
    setOffset({ x: 0, y: 0 });
  }

  const remembered = (id: string, rect: DOMRect, scale: number) => {
    const saved = layouts[id];
    return saved
      ? { left: rect.right + saved.x * scale, top: rect.top + saved.y * scale }
      : undefined;
  };
  const box = (id: string) => {
    const { w, h } = layouts[id] ?? {};
    return w && h ? { w, h } : undefined;
  };
  const always = alwaysShow
    ? annotations.flatMap((annotation) => {
        if (!annotation.note.trim() || annotation.id === editor?.annotationId)
          return [];
        const found = noteAnchor(annotation.id);
        if (
          !found ||
          found.rect.bottom < 0 ||
          found.rect.top > window.innerHeight
        )
          return [];
        return [{ annotation, ...found }];
      })
    : [];
  const covered = new Set(always.map(({ annotation }) => annotation.id));
  const notes =
    !editor && shown
      ? annotations.filter(
          (a) =>
            shown.ids.includes(a.id) && a.note.trim() && !covered.has(a.id),
        )
      : [];
  const hoverAnchor = notes[0] ? noteAnchor(notes[0].id) : undefined;
  const hoverSaved = notes[0] && layouts[notes[0].id];
  const hoverPlace: Placement =
    hoverAnchor?.element && hoverSaved
      ? { element: hoverAnchor.element, x: hoverSaved.x, y: hoverSaved.y }
      : hoverAnchor && hoverSaved
        ? {
            point: remembered(
              notes[0].id,
              hoverAnchor.rect,
              hoverAnchor.scale,
            )!,
          }
        : { beside: shown?.anchor ?? { x: 0, top: 0, bottom: 0 } };

  // Layouts are stored in card units so they keep their place on the page
  // across zoom levels.
  const moved = (id: string, left: number, top: number, size?: CardBox) => {
    const found = noteAnchor(id);
    if (!found) return;
    const unit = (px: number) => Math.round((px / found.scale) * 10) / 10;
    const kept = box(id);
    onLayout?.(id, {
      x: unit(left - found.rect.right),
      y: unit(top - found.rect.top),
      ...(size
        ? { w: Math.round(size.w), h: Math.round(size.h) }
        : kept && { w: kept.w, h: kept.h }),
    });
  };
  const edit = (annotation: Annotation, card: DOMRect) => {
    close();
    // The editor opens where the card was.
    onEdit(annotation, {
      x: card.left - 13,
      top: card.top,
      bottom: card.top + 1,
    });
  };

  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const start = { x: event.clientX - offset.x, y: event.clientY - offset.y };
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

  const [uploading, setUploading] = useState(false);
  // Saving closes the card; wait until pasted images are in the Markdown.
  const canSave =
    !!editor &&
    !editor.saving &&
    !uploading &&
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
    <>
      {always.map(({ annotation, rect, scale, element, container }) => (
        <NoteCard
          key={annotation.id}
          notes={[annotation]}
          place={
            element
              ? {
                  element,
                  x: layouts[annotation.id]?.x ?? 12,
                  y: layouts[annotation.id]?.y ?? 0,
                }
              : {
                  point: remembered(annotation.id, rect, scale) ?? {
                    left: rect.right + 12 * scale,
                    top: rect.top,
                  },
                }
          }
          scale={scale}
          size={box(annotation.id)}
          container={container}
          opacity={opacity}
          dismissible={false}
          onEdit={edit}
          onMoved={(left, top, size) => moved(annotation.id, left, top, size)}
        />
      ))}
      {shown && notes.length > 0 && (
        <NoteCard
          key={shown.ids.join(",")}
          notes={notes}
          place={hoverPlace}
          scale={hoverAnchor?.scale ?? 1}
          size={box(notes[0].id)}
          container={hoverAnchor?.container}
          opacity={opacity}
          dismissible
          onEdit={edit}
          onMoved={(left, top, size) => moved(notes[0].id, left, top, size)}
          onDragStart={() => {
            pinned.current = true;
            cancel();
          }}
          onDismiss={close}
          onPointerEnter={() => {
            inside.current = true;
            cancel();
          }}
          onPointerLeave={() => {
            inside.current = false;
            leave();
          }}
        />
      )}
      <Popover
        open={!!editor}
        onOpenChange={(next, details) => {
          if (next || !editor || editor.saving) return;
          // A stray click in the page must not discard a typed draft.
          if (
            editor.value !== editor.initial &&
            editor.value.trim() &&
            details.reason !== "escape-key"
          )
            return;
          editor.onClose();
        }}
      >
        {editor && anchor && (
          <PopoverContent
            anchor={anchorRect(anchor)}
            side="right"
            align="start"
            sideOffset={12}
            initialFocus={false}
            finalFocus={false}
            style={{ translate: `${offset.x}px ${offset.y}px` }}
            className="max-h-[min(30rem,80vh)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto transition-none"
            data-annotation-preview=""
          >
            <PopoverTitle className="sr-only">{title}</PopoverTitle>
            <div
              onKeyDownCapture={(event) => {
                if (
                  (event.target as Element).closest("[data-note-math-editor]")
                )
                  return;
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (canSave) editor.onSave();
                }
              }}
            >
              <PaperNoteRichEditor
                documentId={editor.documentId}
                body={editor.value}
                disabled={editor.saving}
                ariaLabel={title}
                placeholder={
                  editor.kind === "question" ? "想弄清楚什么？" : "批注内容…"
                }
                autoFocus
                className="annotation-markdown-editor"
                diagnosticScope="annotation_note"
                onChange={editor.onChange}
                onUploadingChange={setUploading}
                leading={grip}
                toolbarPlacement="bottom"
                actions={
                  <>
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
                      className="rounded-full"
                      disabled={!canSave}
                      onClick={editor.onSave}
                    >
                      <Check className="size-3.5" />
                    </CardButton>
                  </>
                }
              />
            </div>
          </PopoverContent>
        )}
      </Popover>
    </>
  );
}
