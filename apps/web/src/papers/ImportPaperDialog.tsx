import { useEffect, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@reader/ui/components/dialog";
import { toast } from "sonner";
import { libraryModes } from "../LibraryModeSwitcher";
import { importReference } from "./actions";
import { paperCategories } from "./model";
import { usePaperUI } from "./state";
import { useReaderStore } from "../store";
import { ZoteroImportDialog } from "./ZoteroImportDialog";

export function ImportPaperDialog({
  open,
  onOpenChange,
  onChooseFiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseFiles: (folder: string) => void;
}) {
  const [migration, setMigration] = useState<"zotero" | "endnote" | null>(null);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const { documents, libraryPreferences } = useReaderStore();
  const categories = paperCategories(
    libraryPreferences.papers || {},
    documents.filter((doc) => doc.library === "papers"),
  );
  const smartCategories = libraryPreferences.papers?.smartCategories || [];
  const smart = smartCategories.find((item) => `smart:${item.id}` === folder);
  useEffect(() => {
    if (!open) return;
    const view = usePaperUI.getState().view;
    const current =
      view.startsWith("folder:") && categories.includes(view.slice(7))
        ? view
        : view.startsWith("smart:") &&
            smartCategories.some((item) => `smart:${item.id}` === view)
          ? view
          : "";
    setFolder(current);
    // Capture the current view when the dialog opens, not when the library refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async () => {
    if (!ref.trim() || busy) return;
    setBusy(true);
    try {
      const doc = await importReference(ref, folder);
      if (doc.library === "papers") toast.success(`已导入《${doc.title}》`);
      else
        toast.info(
          `这篇论文已在${libraryModes[doc.library].label}中，可在那里移动`,
        );
      setRef("");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (migration)
    return (
      <ZoteroImportDialog
        source={migration}
        open={open}
        onOpenChange={(next) => {
          if (!next) setMigration(null);
          onOpenChange(next);
        }}
      />
    );
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入论文</DialogTitle>
          <DialogDescription>
            arXiv 编号、DOI、论文页面或 PDF 链接、完整标题
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium" id="import-paper-folder-label">
            导入到分类
          </span>
          <Select
            value={folder || "none"}
            onValueChange={(value) =>
              setFolder(value === "none" ? "" : value || "")
            }
            disabled={busy}
          >
            <SelectTrigger
              aria-labelledby="import-paper-folder-label"
              className="w-full"
            >
              <SelectValue>
                {smart
                  ? `${smart.name}（智能标签）`
                  : folder
                    ? folder.slice(7).replaceAll("/", " / ")
                    : "-"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">-</SelectItem>
              {categories.map((name) => (
                <SelectItem key={name} value={`folder:${name}`}>
                  {name.replaceAll("/", " / ")}
                </SelectItem>
              ))}
              {smartCategories.map((item) => (
                <SelectItem key={`smart:${item.id}`} value={`smart:${item.id}`}>
                  {item.name}（智能标签）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            aria-label="论文标识或链接"
            placeholder="例如 2401.01234 或 10.1145/…"
            value={ref}
            disabled={busy}
            onChange={(e) => setRef(e.target.value)}
          />
          <Button type="submit" disabled={!ref.trim() || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "下载中" : "导入"}
          </Button>
        </form>
        <div className="paper-import-divider">或</div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            onOpenChange(false);
            onChooseFiles(folder);
          }}
        >
          <FileUp />
          选择 PDF 文件
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setMigration("zotero")}
        >
          从 Zotero 导入
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setMigration("endnote")}
        >
          从 EndNote 导入
        </Button>
      </DialogContent>
    </Dialog>
  );
}
