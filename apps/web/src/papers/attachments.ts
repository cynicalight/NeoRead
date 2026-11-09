import { useEffect } from "react";
import { create } from "zustand";
import { api, type PaperAttachment } from "@neoread/api";
import type { Document } from "@neoread/core";
import { toast } from "sonner";
import { refreshLibrary } from "../store";
import { downloadBlob } from "../download";
import { openLink } from "./actions";

export type UploadEntry = {
  name: string;
  file?: File;
  status:
    | "queued"
    | "uploading"
    | "saving"
    | "done"
    | "duplicate"
    | "failed"
    | "cancelled";
  fraction: number;
  error?: string;
};
type UploadBatch = {
  entries: UploadEntry[];
  controller: AbortController;
  running: boolean;
};
export const useAttachments = create<{
  items: Record<string, PaperAttachment[] | undefined>;
  errors: Record<string, string | undefined>;
  uploads: Record<string, UploadBatch | undefined>;
  expanded: Set<string>;
  selected: PaperAttachment | null;
  preview: { doc: Document; item: PaperAttachment } | null;
  adding: { doc: Document; kind: "file" | "link" } | null;
  managing: { item: PaperAttachment; action: "rename" | "remove" } | null;
}>(() => ({
  items: {},
  errors: {},
  uploads: {},
  expanded: new Set(),
  selected: null,
  preview: null,
  adding: null,
  managing: null,
}));

const requests = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
export function loadAttachments(id: string): Promise<void> {
  const pending = requests.get(id);
  if (pending) return pending;
  const generation = generations.get(id) || 0;
  const task = api
    .paperAttachments(id)
    .then((items) => {
      if (generation !== (generations.get(id) || 0)) return;
      useAttachments.setState((s) => ({
        items: { ...s.items, [id]: items },
        errors: { ...s.errors, [id]: undefined },
        selected:
          s.selected?.documentId === id
            ? items.find((a) => a.id === s.selected?.id) || null
            : s.selected,
      }));
    })
    .catch((e: Error) => {
      if (generation !== (generations.get(id) || 0)) return;
      useAttachments.setState((s) => ({
        errors: { ...s.errors, [id]: e.message },
      }));
    })
    .finally(() => {
      requests.delete(id);
      if (generation !== (generations.get(id) || 0)) void loadAttachments(id);
    });
  requests.set(id, task);
  return task;
}
export function useLoadAttachments(doc: Document) {
  useEffect(() => {
    void loadAttachments(doc.id);
  }, [doc]);
}
export function putAttachment(item: PaperAttachment) {
  generations.set(item.documentId, (generations.get(item.documentId) || 0) + 1);
  useAttachments.setState((s) => {
    const items = s.items[item.documentId] || [];
    return {
      items: {
        ...s.items,
        [item.documentId]: items.some((a) => a.id === item.id)
          ? items.map((a) => (a.id === item.id ? item : a))
          : [...items, item],
      },
      selected: s.selected?.id === item.id ? item : s.selected,
    };
  });
}
export function forgetAttachment(item: PaperAttachment) {
  generations.set(item.documentId, (generations.get(item.documentId) || 0) + 1);
  useAttachments.setState((s) => ({
    items: {
      ...s.items,
      [item.documentId]: (s.items[item.documentId] || []).filter(
        (a) => a.id !== item.id,
      ),
    },
    selected: s.selected?.id === item.id ? null : s.selected,
  }));
}
export function toggleAttachments(id: string, open?: boolean) {
  useAttachments.setState((s) => {
    const expanded = new Set(s.expanded);
    if (open ?? !expanded.has(id)) expanded.add(id);
    else expanded.delete(id);
    return { expanded };
  });
}
export const attachmentSize = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(size / 1024))} KB`;
export function attachmentPreviewKind(item: PaperAttachment) {
  if (item.kind !== "file") return null;
  if (/\.pdf$/i.test(item.filename)) return "pdf";
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(item.filename)) return "image";
  return null;
}
export async function downloadAttachment(
  item: PaperAttachment,
  signal?: AbortSignal,
) {
  const blob = await api.downloadPaperAttachment(
    item.documentId,
    item.id,
    signal,
  );
  if (!signal?.aborted) downloadBlob(blob, item.filename);
}
export function openAttachment(doc: Document, item: PaperAttachment) {
  if (item.kind === "link") openLink(item.url);
  else if (attachmentPreviewKind(item))
    useAttachments.setState({ preview: { doc, item } });
  else
    void downloadAttachment(item).catch((e: Error) => toast.error(e.message));
}

/** Uploads live outside the detail panel, so selecting another paper keeps them running. */
export async function uploadAttachments(doc: Document, files: File[]) {
  if (!files.length) return;
  if (useAttachments.getState().uploads[doc.id]?.running) {
    toast.info("这篇论文的附件仍在上传，请等待完成或取消");
    return;
  }
  const controller = new AbortController();
  const entries: UploadEntry[] = files.map((file) => ({
    name: file.name,
    file,
    status: "queued",
    fraction: 0,
  }));
  const update = () =>
    useAttachments.setState((s) => ({
      uploads: {
        ...s.uploads,
        [doc.id]: { entries: [...entries], controller, running: true },
      },
    }));
  update();
  toggleAttachments(doc.id, true);
  await loadAttachments(doc.id);
  const known = new Set(
    (useAttachments.getState().items[doc.id] || []).map((a) => a.id),
  );
  for (const entry of entries) {
    if (controller.signal.aborted) {
      entry.status = "cancelled";
      continue;
    }
    if (entry.file!.size > 512 * 1024 * 1024) {
      entry.status = "failed";
      entry.error = "文件超过 512 MB";
      update();
      continue;
    }
    entry.status = "uploading";
    update();
    try {
      const item = await api.addPaperAttachment(doc.id, entry.file!, {
        signal: controller.signal,
        onProgress: (fraction) => {
          entry.fraction = fraction;
          entry.status = fraction === 1 ? "saving" : "uploading";
          update();
        },
      });
      putAttachment(item);
      entry.status = known.has(item.id) ? "duplicate" : "done";
      entry.fraction = 1;
      entry.file = undefined;
      known.add(item.id);
    } catch (e) {
      entry.status = controller.signal.aborted ? "cancelled" : "failed";
      entry.error = controller.signal.aborted
        ? undefined
        : (e as Error).message;
    }
    update();
  }
  useAttachments.setState((s) => ({
    uploads: {
      ...s.uploads,
      [doc.id]: entries.some(
        (e) => e.status === "failed" || e.status === "cancelled",
      )
        ? { entries: [...entries], controller, running: false }
        : undefined,
    },
  }));
  // A cancelled response may already have been committed; reconcile with the server.
  await loadAttachments(doc.id);
  await refreshLibrary().catch(() => {});
  const done = entries.filter((e) => e.status === "done").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const duplicates = entries.filter((e) => e.status === "duplicate").length;
  if (failed)
    toast.error(
      `《${doc.title}》：${done} 个附件已添加，${failed} 个失败，可重试`,
    );
  else if (done) toast.success(`已为《${doc.title}》添加 ${done} 个附件`);
  else if (duplicates) toast.info("这些附件已在论文中");
}
