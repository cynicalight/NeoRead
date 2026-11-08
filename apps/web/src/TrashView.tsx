import { useState } from "react";
import { BookOpen, FileText, RotateCcw, Trash2 } from "lucide-react";
import type { Document } from "@neoread/core";
import { api } from "@neoread/api";
import { toast } from "sonner";
import { Button } from "@neoread/ui/components/button";
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
import { refreshTrash, useReaderStore, libraryMode } from "./store";
import { discardPaperNotes } from "./paper-note-state";
import { restoreLibraryDocuments } from "./library-actions";

const deletedLabel = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

export function TrashView({ documents }: { documents: Document[] }) {
  const mode = useReaderStore((s) => libraryMode(s.libraryPreferences));
  const [purging, setPurging] = useState<Document[] | null>(null);
  const [busy, setBusy] = useState(false);
  const purge = async () => {
    if (!purging) return;
    setBusy(true);
    try {
      if (purging.length === documents.length && purging.length > 1) {
        await api.emptyTrash(mode);
        discardPaperNotes(purging.map((d) => d.id));
      } else {
        for (const d of purging) {
          await api.removeDocument(d.id);
          discardPaperNotes([d.id]);
        }
      }
      toast.success(`已彻底删除 ${purging.length} 份`);
      setPurging(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      await refreshTrash().catch(() => {});
    }
  };
  return (
    <section aria-label="回收站" className="trash-view">
      <div className="trash-toolbar">
        <span className="text-sm text-muted-foreground">
          {documents.length} 份
        </span>
        <Button
          size="sm"
          variant="destructive-ghost"
          disabled={!documents.length}
          onClick={() => setPurging(documents)}
        >
          <Trash2 />
          清空回收站
        </Button>
      </div>
      {!documents.length && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          回收站是空的
        </p>
      )}
      <ul className="trash-list">
        {documents.map((d) => (
          <li key={d.id} className="trash-row">
            {d.type === "epub" ? <BookOpen /> : <FileText />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={d.title}>
                {d.title}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {[
                  d.author,
                  deletedLabel(d.deletedAt) &&
                    `${deletedLabel(d.deletedAt)} 删除`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void restoreLibraryDocuments([d.id])}
            >
              <RotateCcw />
              恢复
            </Button>
            <Button
              size="sm"
              variant="destructive-ghost"
              onClick={() => setPurging([d])}
            >
              彻底删除
            </Button>
          </li>
        ))}
      </ul>
      <AlertDialog
        open={!!purging}
        onOpenChange={(open) => {
          if (!open && !busy) setPurging(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              彻底删除 {purging?.length ?? 0} 份？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将删除书库中的副本、附件、批注、笔记、对话和阅读记录，无法恢复。导入前的原始文件不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void purge()}
            >
              {busy ? "删除中…" : "彻底删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
