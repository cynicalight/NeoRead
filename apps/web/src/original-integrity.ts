import { useEffect } from "react";
import type { Document } from "@neoread/core";
import { toast } from "sonner";

export const modifiedOriginalLabel =
  "原件已被修改，请彻底删除（包括回收站）后重新导入";

const notified = new Set<string>();

/** Warn once per session for each library original edited after import. */
export function useModifiedOriginalNotice(documents: Document[]) {
  useEffect(() => {
    for (const doc of documents) {
      const id = "modified-original:" + doc.id;
      if (!doc.originalModified) {
        if (notified.delete(doc.id)) toast.dismiss(id);
        continue;
      }
      if (notified.has(doc.id)) continue;
      notified.add(doc.id);
      toast.warning(`《${doc.title}》的原件已被直接修改`, {
        id,
        description:
          "书库中的原件不能修改，修改后与导入记录不一致，批注和译文可能无法对应。请彻底删除该文档（包括回收站）后重新导入；只移到回收站时，重新导入会恢复原记录。",
        duration: Infinity,
        closeButton: true,
      });
    }
  }, [documents]);
}
