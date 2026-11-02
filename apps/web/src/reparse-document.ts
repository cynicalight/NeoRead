import { api } from "@neoread/api";
import type { Document } from "@neoread/core";
import { toast } from "sonner";
import { refreshLibrary } from "./store";
import { refreshDocumentCover } from "./book-cover";

const pending = new Set<string>();

export async function reparseDocument(doc: Document) {
  if (pending.has(doc.id)) return;
  pending.add(doc.id);
  const message = toast.loading(`正在重新解析《${doc.title}》…`);
  try {
    await api.reparseDocument(doc.id);
    await refreshLibrary().catch(() => {});
    try {
      await refreshDocumentCover(doc);
    } catch (error) {
      toast.error(
        `文档重新解析完成，但封面刷新失败：${(error as Error).message}`,
        { id: message },
      );
      return;
    }
    toast.success("重新解析完成。请重新打开文档查看结果。", { id: message });
  } catch (error) {
    toast.error((error as Error).message, { id: message });
  } finally {
    pending.delete(doc.id);
  }
}
