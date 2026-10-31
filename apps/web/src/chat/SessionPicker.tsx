import { useEffect, useState, type ReactNode } from "react";
import { Plus, Pencil } from "lucide-react";
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
import { Input } from "@neoread/ui/components/input";
import { toast } from "sonner";

const statusLabels = {
  running: "运行中",
  completed: "已完成",
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
  return (
    <div className="pointer-events-none absolute inset-x-3 top-2 z-10 min-w-0">
      <div className="flex min-w-0 items-center gap-1 [&>button]:pointer-events-auto">
        <Select
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
          <SelectContent>
            {sessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="max-w-44 truncate">{s.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {s.latestRun ? statusLabels[s.latestRun.status] : ""}
                </span>
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
    </div>
  );
}
