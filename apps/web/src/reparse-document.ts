import { api } from "@neoread/api";
import type { Document, Processing } from "@neoread/core";
import { toast } from "sonner";
import { refreshLibrary } from "./store";
import { refreshDocumentCover } from "./book-cover";

const submitting = new Set<string>();
const accepted = new Map<
  string,
  {
    doc: Document;
    layoutRevision?: string;
    acceptedAt: number;
    waiting: boolean;
  }
>();

export function trackReparsePublication(doc: Document, job: Processing) {
  accepted.set(doc.id, {
    doc,
    layoutRevision: job.layoutRevision,
    acceptedAt: Date.parse(job.updatedAt),
    waiting: false,
  });
}
export async function reparseDocument(doc: Document) {
  if (submitting.has(doc.id)) return;
  submitting.add(doc.id);
  const message = toast.loading(`正在提交《${doc.title}》的重新解析…`);
  try {
    const job = await api.reparseDocument(doc.id);
    trackReparsePublication(doc, job);
    toast.success(`已开始重新解析《${doc.title}》，进度见处理状态。`, {
      id: message,
    });
  } catch (error) {
    toast.error((error as Error).message, { id: message });
  } finally {
    submitting.delete(doc.id);
  }
}

/** Fed each processing poll; refreshes the cover after the new source is published. */
export function observeReparsedLayouts(jobs: Processing[]) {
  for (const [id, entry] of accepted) {
    const job = jobs.find((j) => j.documentId === id);
    if (!job || Date.parse(job.updatedAt) < entry.acceptedAt) continue;
    if (job.layoutRevision && job.layoutRevision !== entry.layoutRevision) {
      accepted.delete(id);
      void publishCover(entry.doc);
    } else if (job.status === "failed") {
      accepted.delete(id);
      toast.error(`《${entry.doc.title}》重新解析失败：${job.detail}`);
    } else if (job.status === "waiting" && !entry.waiting) {
      entry.waiting = true;
      toast.warning(`《${entry.doc.title}》重新解析正在等待：${job.detail}`);
    } else if (job.status !== "waiting") entry.waiting = false;
  }
}

async function publishCover(doc: Document) {
  await refreshLibrary().catch(() => {});
  try {
    await refreshDocumentCover(doc);
  } catch (error) {
    toast.error(
      `《${doc.title}》已重新解析，但封面刷新失败：${(error as Error).message}`,
    );
  }
}
