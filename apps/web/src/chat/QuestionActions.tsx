import { useRef, useState } from "react";
import { Pencil, Undo2 } from "lucide-react";
import type { Message } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Textarea } from "@neoread/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@neoread/ui/components/alert-dialog";
import type { ChatSession } from "./chat-session";
import { AnswerActions } from "./AnswerActions";

export function QuestionActions({
  message,
  following,
  session,
  disabled,
  onRegenerate,
  onWithdraw,
}: {
  message: Message;
  following: number;
  session: ChatSession;
  disabled: boolean;
  onRegenerate: () => void;
  onWithdraw: (message: Message) => void;
}) {
  const [mode, setMode] = useState<"edit" | "withdraw">();
  const [content, setContent] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const restoredDraft = useRef(false);
  const open = (next: "edit" | "withdraw") => {
    restoredDraft.current = false;
    setContent(message.content);
    setError("");
    setMode(next);
  };
  const change = async (edit: boolean) => {
    if (saving || disabled) return;
    setSaving(true);
    setError("");
    try {
      // Keep the original input even if the server commits and the response
      // is lost. Retrying the same withdrawal must not append it twice.
      if (!edit && !restoredDraft.current) {
        onWithdraw(message);
        restoredDraft.current = true;
      }
      await session.changeMessage(message, edit ? content : undefined);
      setMode(undefined);
      if (edit) {
        restoredDraft.current = false;
        onRegenerate();
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const impact = following
    ? `此问题之后的 ${following} 条消息（含回答和后续提问）将被移除。`
    : "";
  const title = disabled ? "请先停止回答，等待操作结束" : undefined;
  return (
    <>
      <AnswerActions
        content={message.content}
        timestamp={message.createdAt ? new Date(message.createdAt) : undefined}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="编辑问题"
          title={title || "编辑问题"}
          disabled={disabled}
          onClick={() => open("edit")}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="撤回问题"
          title={title || "撤回问题"}
          disabled={disabled}
          onClick={() => open("withdraw")}
        >
          <Undo2 aria-hidden="true" />
        </Button>
      </AnswerActions>
      <Dialog
        open={mode === "edit"}
        onOpenChange={(value) => {
          if (!value && !saving) setMode(undefined);
        }}
      >
        <DialogContent showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>编辑问题</DialogTitle>
            <DialogDescription>
              {impact}保留原引用、附件和阅读位置，保存后重新生成回答。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="问题内容"
            rows={6}
            value={content}
            disabled={saving}
            onChange={(event) => setContent(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setMode(undefined)}
            >
              取消
            </Button>
            <Button
              disabled={saving || disabled || !content.trim()}
              onClick={() => void change(true)}
            >
              {saving ? "正在保存…" : "保存并重新生成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={mode === "withdraw"}
        onOpenChange={(value) => {
          if (!value && !saving) setMode(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤回这条问题？</AlertDialogTitle>
            <AlertDialogDescription>
              {impact}问题、引用和附件将放回输入框，与已有草稿合并。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving || disabled}
              onClick={() => void change(false)}
            >
              {saving ? "正在撤回…" : "确认撤回"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
