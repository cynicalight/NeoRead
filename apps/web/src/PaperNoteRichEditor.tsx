import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import { Textarea } from "@neoread/ui/components/textarea";
import { reportDiagnostic } from "./diagnostics";
import { diagnosticError } from "../../../packages/neoread-core/src/diagnostics";
import "./chat/markdown.css";
import { toast } from "sonner";
import { PaperNoteMathEditor } from "./PaperNoteMathEditor";
import type { MathEditRequest } from "./paper-note-math";
import { openNoteImagePreview } from "./NoteImage";
import {
  appendNoteMarkdown,
  mapTextOffset,
  pastedNoteImages,
  uploadNoteImages,
  type NoteInsertionPoint,
} from "./note-images";

export function PaperNoteRichEditor({
  documentId,
  body,
  disabled,
  onChange,
  onUploadingChange,
  onOrphanedImage,
  onBlur,
  leading,
  actions,
  besideTabs,
  toolbarPlacement = "top",
  ariaLabel = "编辑论文笔记",
  placeholder = "使用 Markdown 记录要点、疑问和启发…",
  autoFocus = false,
  className = "",
  diagnosticScope = "paper_note",
}: {
  /** Pasted images are stored with this paper's attachments. */
  documentId: string;
  body: string;
  disabled: boolean;
  onChange: (body: string) => void;
  /** True while a pasted image is still uploading and not yet in `body`. */
  onUploadingChange?: (uploading: boolean) => void;
  /**
   * Receives image Markdown whose upload finished after this editor unmounted.
   * Omit when unmounting means discarding the draft.
   */
  onOrphanedImage?: (markdown: string) => void;
  onBlur?: () => void;
  /** Start-side toolbar slot; when set the mode tabs sit centered. */
  leading?: ReactNode;
  actions?: ReactNode;
  /** Controls placed right after the mode tabs, before the end-side actions. */
  besideTabs?: ReactNode;
  /** Compact editors keep their controls below the input. */
  toolbarPlacement?: "top" | "bottom";
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  diagnosticScope?: "paper_note" | "annotation_note";
}) {
  const [source, setSource] = useState(false);
  const [mathEdit, setMathEdit] = useState<
    (MathEditRequest & { id: number }) | null
  >(null);
  const mathEditSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [uploads, setUploads] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const focusRequested = useRef(false);
  const editorRef = useRef<{
    setMarkdown: (body: string) => void;
    focus?: () => void;
  } | null>(null);
  const showError = (
    error: unknown,
    stage: "import" | "initialize" | "synchronize",
  ) => {
    const unsupported =
      error instanceof Error &&
      error.message === "笔记包含暂不支持的格式，已保留在源码中编辑";
    try {
      reportDiagnostic({
        level: unsupported ? "warn" : "error",
        event: `${diagnosticScope}.editor.${stage}_fallback`,
        // Parser errors can contain Markdown in their message and stack.
        // Log only the controlled cause/type, never the exception text.
        detail: unsupported
          ? "unsupported_format"
          : diagnosticError(error).detail,
      });
    } catch {
      // A diagnostic transport failure must not prevent source-mode recovery.
    }
    setReason(
      error instanceof Error && error.message.includes("源码")
        ? error.message
        : "编辑器加载失败，已保留在源码中编辑",
    );
    setLoading(false);
    setSource(true);
  };
  const latest = useRef({
    body,
    onChange,
    onUploadingChange,
    onOrphanedImage,
    documentId,
  });
  latest.current = {
    body,
    onChange,
    onUploadingChange,
    onOrphanedImage,
    documentId,
  };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Source-mode paste positions are Markdown offsets; they follow every body
  // change, whichever editor or caller made it.
  const tracked = useRef(body);
  const textPoints = useRef(new Set<{ offset: number }>());
  const caret = useRef<{ start: number; end: number } | null>(null);
  const track = (next: string) => {
    const previous = tracked.current;
    if (next === previous) return;
    for (const point of textPoints.current)
      point.offset = mapTextOffset(previous, next, point.offset);
    tracked.current = next;
  };
  const commit = (next: string) => {
    const input = sourceInput.current;
    // A programmatic value change would otherwise throw the caret to the end.
    if (input && document.activeElement === input)
      caret.current = {
        start: mapTextOffset(tracked.current, next, input.selectionStart, 1),
        end: mapTextOffset(tracked.current, next, input.selectionEnd, 1),
      };
    track(next);
    latest.current.body = next;
    latest.current.onChange(next);
  };
  const pasteImages = (files: File[], point: NoteInsertionPoint) => {
    setUploads((count) => count + 1);
    void uploadNoteImages(latest.current.documentId, files, new Date())
      .then(
        (markdown) => {
          if (!alive.current) {
            point.release();
            latest.current.onOrphanedImage?.(markdown);
            return;
          }
          if (point.insert(markdown)) return;
          // The rich editor that owned the position is gone (mode switch).
          commit(appendNoteMarkdown(tracked.current, markdown));
        },
        (error: unknown) => {
          point.release();
          toast.error("图片上传失败", {
            description: error instanceof Error ? error.message : undefined,
          });
        },
      )
      .finally(() => {
        if (alive.current) setUploads((count) => count - 1);
      });
  };
  const pasteRef = useRef(pasteImages);
  pasteRef.current = pasteImages;
  const uploading = uploads > 0;
  useEffect(() => {
    if (!uploading) return;
    latest.current.onUploadingChange?.(true);
    return () => latest.current.onUploadingChange?.(false);
  }, [uploading]);
  useLayoutEffect(() => {
    track(body);
    try {
      editorRef.current?.setMarkdown(body);
    } catch (error) {
      showError(error, "synchronize");
    }
    const input = sourceInput.current;
    if (caret.current && input) {
      input.setSelectionRange(caret.current.start, caret.current.end);
      caret.current = null;
    }
  }, [body]);
  useEffect(() => {
    if (source || disabled) return;
    let active = true;
    // A separate mount isolates pending async creation during Strict Mode cleanup.
    const mount = document.createElement("div");
    container.current!.append(mount);
    let destroy: (() => Promise<unknown>) | undefined;
    setLoading(true);
    setReason("");
    let stage: "import" | "initialize" | "synchronize" = "import";
    void import("./paper-note-milkdown")
      .then(({ createPaperNoteEditor }) => {
        stage = "initialize";
        return active
          ? createPaperNoteEditor(
              mount,
              () => latest.current.body,
              (markdown) => {
                if (!active) return;
                track(markdown);
                latest.current.body = markdown;
                latest.current.onChange(markdown);
              },
              {
                ariaLabel,
                onEditMath: (request) => {
                  if (active)
                    setMathEdit({ ...request, id: ++mathEditSequence.current });
                },
                onOpenImage: (request) => {
                  if (active) openNoteImagePreview(request);
                },
                onPasteImages: (files, point) => pasteRef.current(files, point),
              },
            )
          : undefined;
      })
      .then(async (editor) => {
        if (!editor) return;
        if (!active) {
          await editor.destroy();
          return;
        }
        destroy = () => editor.destroy();
        editorRef.current = editor;
        stage = "synchronize";
        editor.setMarkdown(latest.current.body);
        if (autoFocus) focusRequested.current = true;
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        showError(error, stage);
      });
    return () => {
      active = false;
      editorRef.current = null;
      mount.remove();
      void destroy?.();
    };
  }, [source, disabled, ariaLabel, autoFocus]);
  // The rich surface shows (and animates in) while its chunk loads; there is
  // no loading notice or source fallback for the short wait.
  const showSource = source || disabled || !!reason;
  useLayoutEffect(() => {
    if (showSource || loading || !focusRequested.current) return;
    focusRequested.current = false;
    editorRef.current?.focus?.();
  }, [showSource, loading]);
  const toolbar = (
    <div
      className="paper-note-toolbar"
      data-centered={leading ? "" : undefined}
    >
      {leading && <div className="paper-note-leading">{leading}</div>}
      <Tabs
        value={source ? "source" : "rich"}
        onValueChange={(value) => {
          if (value === "source") {
            setMathEdit(null);
            setSource(true);
          } else {
            focusRequested.current = autoFocus;
            setSource(false);
          }
        }}
      >
        <TabsList aria-label={`${ariaLabel}模式`}>
          <TabsTrigger value="rich" className="px-2.5 text-xs">
            编辑
          </TabsTrigger>
          <TabsTrigger value="source" className="px-2.5 text-xs">
            源码
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {besideTabs}
      {actions && <div className="paper-note-actions">{actions}</div>}
    </div>
  );
  return (
    <div className={`paper-note-workspace ${className}`}>
      {toolbarPlacement === "top" && toolbar}
      {reason && (
        <p className="paper-note-editor-message" role="status">
          {reason}
        </p>
      )}
      {uploading && (
        <p className="paper-note-editor-message" role="status">
          正在上传图片…
        </p>
      )}
      {showSource && (
        <Textarea
          ref={sourceInput}
          aria-label={ariaLabel}
          placeholder={placeholder}
          autoFocus={autoFocus && !disabled}
          disabled={disabled}
          value={body}
          onChange={(event) => {
            // Stay in source if the user starts typing while the chunk loads.
            setSource(true);
            track(event.target.value);
            latest.current.body = event.target.value;
            onChange(event.target.value);
          }}
          onPaste={(event) => {
            const files = pastedNoteImages(event.clipboardData);
            if (!files.length) return;
            event.preventDefault();
            setSource(true);
            const input = event.currentTarget;
            const { selectionStart: start, selectionEnd: end, value } = input;
            const point = { offset: start };
            textPoints.current.add(point);
            const selected = value.slice(start, end);
            pasteImages(files, {
              insert(markdown) {
                if (!textPoints.current.delete(point)) return false;
                const current = tracked.current;
                const at = Math.min(point.offset, current.length);
                const end = current.startsWith(selected, at)
                  ? at + selected.length
                  : at;
                commit(current.slice(0, at) + markdown + current.slice(end));
                return true;
              },
              release: () => textPoints.current.delete(point),
            });
          }}
          onBlur={onBlur}
          className="paper-note-editor-input"
        />
      )}
      {!showSource && mathEdit && (
        <PaperNoteMathEditor
          key={mathEdit.id}
          request={mathEdit}
          onClose={() => setMathEdit(null)}
        />
      )}
      <div
        ref={container}
        className="paper-note-rich message-markdown paper-note-markdown"
        hidden={showSource}
        onBlur={onBlur}
      />
      {toolbarPlacement === "bottom" && toolbar}
    </div>
  );
}
