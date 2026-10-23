import { useEffect, useRef, useState } from "react";
import { Button } from "@reader/ui/components/button";
import { Textarea } from "@reader/ui/components/textarea";
import "./chat/markdown.css";

export function PaperNoteRichEditor({
  body,
  disabled,
  onChange,
  onBlur,
}: {
  body: string;
  disabled: boolean;
  onChange: (body: string) => void;
  onBlur: () => void;
}) {
  const [source, setSource] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef({ body, onChange });
  latest.current = { body, onChange };
  useEffect(() => {
    if (source || disabled) return;
    let active = true;
    // A separate mount isolates pending async creation during Strict Mode cleanup.
    const mount = document.createElement("div");
    container.current!.append(mount);
    let destroy: (() => Promise<unknown>) | undefined;
    setLoading(true);
    setReason("");
    void import("./paper-note-milkdown")
      .then(({ createPaperNoteEditor }) =>
        active
          ? createPaperNoteEditor(
              mount,
              () => latest.current.body,
              (markdown) => {
                if (!active) return;
                latest.current.body = markdown;
                latest.current.onChange(markdown);
              },
            )
          : undefined,
      )
      .then(async (editor) => {
        if (!editor) return;
        if (!active) {
          await editor.destroy();
          return;
        }
        destroy = editor.destroy;
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setReason(
          error instanceof Error && error.message.includes("源码")
            ? error.message
            : "编辑器加载失败，已保留在源码中编辑",
        );
        setLoading(false);
        setSource(true);
      });
    return () => {
      active = false;
      mount.remove();
      void destroy?.();
    };
  }, [source, disabled]);
  const showSource = source || disabled || loading || !!reason;
  return (
    <div className="paper-note-workspace">
      <div className="paper-note-toolbar">
        <div className="flex gap-1" role="group" aria-label="笔记编辑模式">
          <Button
            variant={source ? "ghost" : "secondary"}
            size="xs"
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            编辑
          </Button>
          <Button
            variant={source ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            源码
          </Button>
        </div>
        <span
          className="paper-note-shortcuts"
          title="⌘/Ctrl+B 加粗，I 斜体，Z 撤销，Shift+Z 或 Ctrl+Y 重做；列表 Enter 续写，空项 Enter 退出，Tab/Shift+Tab 调整层级；公式在源码中编辑"
        >
          ⌘/Ctrl B · I · Z / ⇧Z　列表 Enter · Tab / ⇧Tab
        </span>
      </div>
      {(reason || (!source && loading && !disabled)) && (
        <p className="paper-note-editor-message" role="status">
          {reason || "编辑器加载中，可先编辑源码"}
        </p>
      )}
      {showSource && (
        <Textarea
          aria-label="编辑论文笔记"
          placeholder="使用 Markdown 记录要点、疑问和启发…"
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
      <div
        ref={container}
        className="paper-note-rich message-markdown paper-note-markdown"
        hidden={showSource}
        onBlur={onBlur}
      />
    </div>
  );
}
