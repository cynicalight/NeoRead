import { useEffect, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Plus, Pencil, Trash2 } from "lucide-react";
import { api } from "@neoread/api";
import type { DocumentChatSession } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@neoread/ui/components/select";
import {
  Dialog,
  DialogContent,
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
import { Input } from "@neoread/ui/components/input";
import { toast } from "sonner";

const statusLabels = {
  running: "",
  completed: "",
  failed: "未完成",
  cancelled: "已停止",
  interrupted: "已中断",
};
export function SessionPicker({
  documentId,
  sessions,
  current,
  provider,
  continueAction,
  onChange,
  onRefresh,
}: {
  documentId: string;
  sessions: DocumentChatSession[];
  current?: DocumentChatSession;
  provider: string;
  continueAction?: ReactNode;
  onChange: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<DocumentChatSession>();
  useEffect(() => {
    setRenaming(false);
    setSaving(false);
  }, [current?.id]);
  const create = async () => {
    setSaving(true);
    try {
      const session = await api.createChatSession(
        documentId,
        provider || "api",
      );
      await onRefresh();
      onChange(session.id);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const update = async (title: string) => {
    if (!current) return;
    setSaving(true);
    try {
      await api.updateChatSession(documentId, current.id, { title });
      await onRefresh();
      setRenaming(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (session: DocumentChatSession) => {
    setSaving(true);
    try {
      await api.deleteChatSession(documentId, session.id);
      await onRefresh();
      const next = sessions.find((s) => s.id !== session.id);
      if (session.id === current?.id && next) onChange(next.id);
      setDeleting(undefined);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  // Keep presses on the delete button from selecting its option.
  const stop = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();
  return (
    <div className="pointer-events-none absolute inset-x-3 top-2 z-10 min-w-0">
      <div className="flex min-w-0 items-center gap-1 [&>button]:pointer-events-auto">
        <Select
          open={open}
          onOpenChange={setOpen}
          value={current?.id ?? null}
          onValueChange={(id) => {
            if (id) onChange(id);
          }}
        >
          <SelectTrigger
            className="h-8 min-w-0 flex-1 bg-background dark:bg-background dark:hover:bg-muted"
            aria-label="选择会话"
          >
            <SelectValue className="truncate">
              {current?.title ?? "加载会话…"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {sessions.map((s) => (
              <SelectItem
                key={s.id}
                value={s.id}
                className="pr-1 [&_[data-slot=select-item-indicator]]:hidden!"
              >
                <span className="max-w-44 truncate">{s.title}</span>
                <span className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
                  {s.latestRun?.status === "running" ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-label="运行中"
                    />
                  ) : s.latestRun ? (
                    statusLabels[s.latestRun.status]
                  ) : null}
                  {s.id === current?.id && s.latestRun?.status !== "running" ? (
                    <Check
                      className="size-4 text-foreground"
                      aria-label="当前会话"
                    />
                  ) : null}
                </span>
                <Button
                  variant="destructive-ghost"
                  size="icon-xs"
                  className="ml-auto"
                  aria-label="删除会话"
                  disabled={saving || s.latestRun?.status === "running"}
                  onPointerDown={stop}
                  onPointerUp={stop}
                  onMouseDown={stop}
                  onMouseUp={stop}
                  onKeyDown={stop}
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    setOpen(false);
                    setDeleting(s);
                  }}
                >
                  <Trash2 />
                </Button>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {continueAction}
        <Button
          variant="ghost"
          size="icon-xs"
          className="bg-background dark:hover:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          aria-label="重命名会话"
          disabled={!current || saving}
          onClick={() => {
            setName(current?.title ?? "");
            setRenaming(true);
          }}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="bg-background dark:hover:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          aria-label="新建会话"
          disabled={saving}
          onClick={() => void create()}
        >
          <Plus />
        </Button>
      </div>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void update(name);
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-label="会话名称"
              autoFocus
            />
            <Button type="submit" disabled={saving || !name.trim()}>
              保存
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleting !== undefined}
        onOpenChange={(next) => {
          if (!next && !saving) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.title}”中的所有对话将被删除，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) void remove(deleting);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
