import { useMemo, useState, type RefObject } from "react";
import { toast } from "sonner";
import { api } from "@neoread/api";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@neoread/ui/components/toggle-group";
import { refreshLibrary, refreshTrash, useReaderStore } from "../store";
import { hasTag, paperTags } from "./model";
import { usePaperUI } from "./state";

export function PaperTagCleanup({
  documents,
  open,
  onClose,
  finalFocus,
}: {
  documents: Document[];
  open: boolean;
  onClose: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!saving}
        finalFocus={finalFocus}
      >
        <PaperTagCleanupForm
          documents={documents}
          onClose={onClose}
          saving={saving}
          setSaving={setSaving}
        />
      </DialogContent>
    </Dialog>
  );
}

// Mounted by the dialog portal only while visible.
function PaperTagCleanupForm({
  documents,
  onClose,
  saving,
  setSaving,
}: {
  documents: Document[];
  onClose: () => void;
  saving: boolean;
  setSaving: (value: boolean) => void;
}) {
  const trash = useReaderStore((s) => s.trash);
  const smart = useReaderStore(
    (s) => s.libraryPreferences.papers?.smartCategories,
  );
  const [tag, setTag] = useState("");
  const trashed = useMemo(
    () => trash.filter((d) => d.library === "papers"),
    [trash],
  );
  const options = useMemo(
    () => paperTags([...documents, ...trashed]),
    [documents, trashed],
  );
  const trashCount = trashed.filter((d) => hasTag(d, tag)).length;
  const count = tag
    ? documents.filter((d) => hasTag(d, tag)).length + trashCount
    : 0;
  const referenced = smart?.filter((category) => hasTag(category, tag)) || [];

  async function remove() {
    if (!count || saving) return;
    setSaving(true);
    try {
      const { changed } = await api.changeLibraryTag(
        "papers",
        tag,
        undefined,
        count,
      );
      const ui = usePaperUI.getState();
      if (hasTag(ui.tagFilter, tag)) {
        ui.setTagFilter({
          ...ui.tagFilter,
          tags: ui.tagFilter.tags.filter(
            (t) => t.toLowerCase() !== tag.toLowerCase(),
          ),
        });
      }
      if (ui.view.toLowerCase() === `tag:${tag.toLowerCase()}`)
        ui.setView("all");
      toast.success(`已从 ${changed} 篇论文移除标签“${tag}”`);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      // A conflict leaves the dialog open with the new library count.
      await Promise.all([refreshLibrary(), refreshTrash()]).catch(() =>
        toast.error("无法刷新论文库"),
      );
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>管理论文标签</DialogTitle>
        <DialogDescription>
          选择要从整个论文库移除的标签，包括回收站中的论文。
        </DialogDescription>
      </DialogHeader>
      {options.length ? (
        <ToggleGroup
          size="sm"
          variant="outline"
          aria-label="要移除的标签"
          className="max-h-48 max-w-full flex-wrap justify-start overflow-y-auto"
          value={tag ? [tag] : []}
          onValueChange={(values: string[]) => setTag(values[0] || "")}
          disabled={saving}
        >
          {options.map((name) => (
            <ToggleGroupItem
              key={name}
              value={name}
              title={name}
              className="max-w-full px-2"
            >
              <span className="truncate">#{name}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <p className="text-sm text-muted-foreground">论文库中没有标签</p>
      )}
      {tag && (
        <div className="space-y-2 break-words text-sm" aria-live="polite">
          <p>
            将从 {count} 篇论文移除“{tag}”
            {trashCount > 0 && `（回收站中有 ${trashCount} 篇）`}。
          </p>
          {referenced.length > 0 && (
            <p>
              智能分类{referenced.map((c) => `“${c.name}”`).join("、")}
              使用此标签。规则将保留，移除后这些分类将暂时没有匹配论文。
            </p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="destructive"
          disabled={!count || saving}
          onClick={() => void remove()}
        >
          {saving ? "正在移除…" : "确认移除"}
        </Button>
      </DialogFooter>
    </>
  );
}
