import { useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  File,
  FilePlus2,
  Link,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Document } from "@neoread/core";
import { api, type PaperAttachment } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Progress } from "@neoread/ui/components/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@neoread/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@neoread/ui/components/alert-dialog";
import { toast } from "sonner";
import { refreshLibrary } from "../store";
import {
  attachmentPreviewKind,
  attachmentSize,
  downloadAttachment,
  forgetAttachment,
  loadAttachments,
  openAttachment,
  putAttachment,
  uploadAttachments,
  useAttachments,
  useLoadAttachments,
} from "./attachments";

export function AttachmentUploads({ doc }: { doc: Document }) {
  const batch = useAttachments((s) => s.uploads[doc.id]);
  if (!batch) return null;
  const complete = batch.entries.filter((e) =>
    ["done", "duplicate"].includes(e.status),
  ).length;
  const retry = batch.entries
    .filter(
      (e) => (e.status === "failed" || e.status === "cancelled") && e.file,
    )
    .map((e) => e.file!);
  return (
    <div
      className="paper-upload"
      aria-label="附件上传队列"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center justify-between gap-2 text-xs"
        role="status"
      >
        <span>
          {batch.running
            ? `正在添加附件 · ${complete}/${batch.entries.length}`
            : "未完成的附件"}
        </span>
        {batch.running ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => batch.controller.abort()}
          >
            取消
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            {retry.length > 0 && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void uploadAttachments(doc, retry)}
              >
                重试未完成项
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="关闭上传结果"
              onClick={() =>
                useAttachments.setState((s) => ({
                  uploads: { ...s.uploads, [doc.id]: undefined },
                }))
              }
            >
              <X />
            </Button>
          </div>
        )}
      </div>
      <ul className="m-0 list-none p-0">
        {batch.entries.map((entry, index) => (
          <li key={index} className="py-1 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={entry.name}>
                {entry.name}
              </span>
              <span
                className={
                  entry.status === "failed"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {
                  {
                    queued: "等待",
                    uploading: `${Math.floor(entry.fraction * 100)}%`,
                    saving: "正在保存…",
                    done: "已添加",
                    duplicate: "已存在",
                    failed: "失败",
                    cancelled: "已取消",
                  }[entry.status]
                }
              </span>
            </div>
            {(entry.status === "uploading" || entry.status === "saving") && (
              <Progress
                className="mt-1 h-1"
                aria-label={`${entry.name} 上传进度`}
                value={entry.fraction * 100}
              />
            )}
            {entry.error && (
              <p className="mt-1 break-words text-destructive">{entry.error}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same attachment actions are available from the paper and attachment details. */
export function PaperAttachments({
  doc,
  only,
}: {
  doc: Document;
  only?: PaperAttachment;
}) {
  useLoadAttachments(doc);
  const saved = useAttachments((s) => s.items[doc.id]);
  const loadError = useAttachments((s) => s.errors[doc.id]);
  const adding = useAttachments((s) => s.adding);
  const managing = useAttachments((s) => s.managing);
  const uploading = useAttachments((s) => !!s.uploads[doc.id]?.running);
  const items = only ? [only] : saved || [];
  const loading = !saved && !loadError;
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<PaperAttachment | "link" | null>(null);
  const [removing, setRemoving] = useState<PaperAttachment | null>(null);
  const [title, setTitle] = useState("");
  const [url, setURL] = useState("");
  const [editError, setEditError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const edit = (item: PaperAttachment | "link") => {
    setTitle(item === "link" ? "" : item.title);
    setURL("");
    setEditError("");
    setEditing(item);
  };
  useEffect(() => {
    if (adding?.doc.id !== doc.id) return;
    if (adding.kind === "link") edit("link");
    else picker.current?.click();
    useAttachments.setState({ adding: null });
  }, [adding, doc.id]);
  useEffect(() => {
    if (
      !managing ||
      managing.item.documentId !== doc.id ||
      managing.item.id !== only?.id
    )
      return;
    if (managing.action === "rename") edit(managing.item);
    else setRemoving(managing.item);
    useAttachments.setState({ managing: null });
  }, [managing, doc.id, only?.id]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || operation.current) return;
    operation.current = true;
    setBusy(true);
    setEditError("");
    try {
      const item =
        editing === "link"
          ? await api.addPaperLink(doc.id, title.trim(), url.trim())
          : await api.renamePaperAttachment(doc.id, editing.id, title.trim());
      putAttachment(item);
      if (mounted.current) setEditing(null);
      await refreshLibrary();
    } catch (e) {
      if (mounted.current) setEditError((e as Error).message);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing || operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      await api.removePaperAttachment(doc.id, removing.id);
      forgetAttachment(removing);
      if (mounted.current) setRemoving(null);
      await refreshLibrary();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const download = async (item: PaperAttachment) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      await downloadAttachment(item);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className="paper-attachments"
      aria-label="论文附件"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = uploading ? "none" : "copy";
        setDragging(!uploading);
      }}
      onDragLeave={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        void uploadAttachments(doc, Array.from(e.dataTransfer.files));
      }}
    >
      {!only && (
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5">
            <Paperclip className="size-3.5" />
            附件
            {items.length > 0 && (
              <span className="tabular-nums">{items.length}</span>
            )}
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy || uploading}
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="添加附件"
                  title="添加附件"
                />
              }
            >
              <Plus />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => picker.current?.click()}>
                <FilePlus2 />
                添加文件…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => edit("link")}>
                <Link />
                添加链接…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <input
        ref={picker}
        hidden
        type="file"
        multiple
        aria-label="选择论文附件"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files || []);
          e.currentTarget.value = "";
          void uploadAttachments(doc, files);
        }}
      />
      {!only && loading ? (
        <p className="py-2 text-xs text-muted-foreground" role="status">
          正在读取附件…
        </p>
      ) : !only && loadError ? (
        <div role="alert" className="py-2 text-xs text-destructive">
          {loadError}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void loadAttachments(doc.id)}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {!items.length && (
            <p className="paper-attachments-empty">
              添加文件或链接，也可将文件拖到这里
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {items.map((item) => (
              <li key={item.id} className="paper-related-row">
                <Button
                  variant="ghost"
                  size="sm"
                  className="paper-related-item paper-attachment-item"
                  disabled={busy}
                  title={
                    item.kind === "link"
                      ? item.url
                      : `${item.filename} · ${attachmentSize(item.size)}`
                  }
                  aria-label={`${item.kind === "link" ? "打开链接" : attachmentPreviewKind(item) ? "预览附件" : "下载附件"} ${item.title}`}
                  onClick={() => openAttachment(doc, item)}
                >
                  {item.kind === "link" ? <Link /> : <File />}
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{item.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {item.kind === "link"
                        ? item.url
                        : `${item.filename} · ${attachmentSize(item.size)}`}
                    </span>
                  </span>
                  {item.kind === "link" ? (
                    <ExternalLink className="text-muted-foreground" />
                  ) : (
                    <Paperclip className="text-muted-foreground" />
                  )}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={busy}
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`附件菜单 ${item.title}`}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openAttachment(doc, item)}>
                      {item.kind === "link" ? <ExternalLink /> : <File />}
                      {item.kind === "link"
                        ? "打开链接"
                        : attachmentPreviewKind(item)
                          ? "预览"
                          : "下载文件"}
                    </DropdownMenuItem>
                    {item.kind === "file" && attachmentPreviewKind(item) && (
                      <DropdownMenuItem onClick={() => void download(item)}>
                        <Download />
                        下载文件
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => edit(item)}>
                      <Pencil />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setRemoving(item)}
                    >
                      <Trash2 />
                      移除附件…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </>
      )}
      {!only && <AttachmentUploads doc={doc} />}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(event) => void save(event)}
            className="grid min-w-0 gap-4"
          >
            <DialogHeader>
              <DialogTitle>
                {editing === "link" ? "添加附件链接" : "重命名附件"}
              </DialogTitle>
              <DialogDescription>
                {editing === "link"
                  ? "保存论文的补充材料或相关网页链接。"
                  : "修改附件的显示名称，下载时保留原文件名。"}
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              名称
              <Input
                autoFocus
                value={title}
                maxLength={255}
                required={editing !== "link"}
                disabled={busy}
                placeholder={
                  editing === "link" ? "可选，默认使用网站名称" : "附件名称"
                }
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {editing === "link" && (
              <label className="grid gap-1.5 text-sm">
                链接
                <Input
                  value={url}
                  type="url"
                  required
                  maxLength={8192}
                  disabled={busy}
                  placeholder="https://"
                  onChange={(event) => setURL(event.target.value)}
                />
              </label>
            )}
            {editError && (
              <p role="alert" className="text-sm text-destructive">
                {editError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || (editing === "link" ? !url.trim() : !title.trim())
                }
              >
                {busy ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除附件？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              将从这篇论文中移除“{removing?.title}”。
              {removing?.kind === "file"
                ? "导入前的原始文件和其他论文的附件不受影响。"
                : "已保存的链接将被删除。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "移除中…" : "移除附件"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
