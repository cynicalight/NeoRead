import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@neoread/ui/components/button";
import { Textarea } from "@neoread/ui/components/textarea";
import { reportDiagnostic } from "./diagnostics";
import { diagnosticError } from "../../../packages/neoread-core/src/diagnostics";
import "./chat/markdown.css";
import { PaperNoteMathEditor } from "./PaperNoteMathEditor";
import type { MathEditRequest } from "./paper-note-math";

export function PaperNoteRichEditor({
  body,
  disabled,
  onChange,
  onBlur,
  actions,
  ariaLabel = "编辑论文笔记",
  placeholder = "使用 Markdown 记录要点、疑问和启发…",
  autoFocus = false,
  className = "",
  diagnosticScope = "paper_note",
}: {
  body: string;
  disabled: boolean;
  onChange: (body: string) => void;
  onBlur?: () => void;
  actions?: ReactNode;
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
  const latest = useRef({ body, onChange });
  latest.current = { body, onChange };
  useLayoutEffect(() => {
    try {
      editorRef.current?.setMarkdown(body);
    } catch (error) {
      showError(error, "synchronize");
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
                latest.current.body = markdown;
                latest.current.onChange(markdown);
              },
              {
                ariaLabel,
                onEditMath: (request) => {
                  if (active)
                    setMathEdit({ ...request, id: ++mathEditSequence.current });
                },
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
        if (autoFocus && document.activeElement === sourceInput.current)
          focusRequested.current = true;
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
  const showSource = source || disabled || loading || !!reason;
  useLayoutEffect(() => {
    if (showSource || !focusRequested.current) return;
    focusRequested.current = false;
    editorRef.current?.focus?.();
  }, [showSource]);
  return (
    <div className={`paper-note-workspace ${className}`}>
      <div className="paper-note-toolbar">
        <div
          className="flex gap-1"
          role="group"
          aria-label={`${ariaLabel}模式`}
        >
          <Button
            variant={source ? "ghost" : "secondary"}
            size="xs"
            aria-pressed={!source}
            onClick={() => {
              focusRequested.current = autoFocus;
              setSource(false);
            }}
          >
            编辑
          </Button>
          <Button
            variant={source ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={source}
            onClick={() => {
              setMathEdit(null);
              setSource(true);
            }}
          >
            源码
          </Button>
        </div>
        {actions && <div className="paper-note-actions">{actions}</div>}
      </div>
      {(reason || (!source && loading && !disabled)) && (
        <p className="paper-note-editor-message" role="status">
          {reason || "编辑器加载中，可先编辑源码"}
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
            latest.current.body = event.target.value;
            onChange(event.target.value);
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
    </div>
  );
}
