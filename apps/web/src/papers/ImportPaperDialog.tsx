import { useEffect, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Separator } from "@neoread/ui/components/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
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
      <DialogContent data-tour="import-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入论文</DialogTitle>
          <DialogDescription className="sr-only">
            选择 PDF、输入论文链接，或从 Zotero、EndNote 迁移
          </DialogDescription>
        </DialogHeader>
        <section className="grid gap-3">
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
              title="arXiv 编号、DOI、论文页面或 PDF 链接、完整标题"
              placeholder="arXiv 编号、DOI、链接或标题，如 2401.01234"
              value={ref}
              disabled={busy}
              onChange={(e) => setRef(e.target.value)}
            />
            <Button type="submit" disabled={!ref.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "下载中" : "导入"}
            </Button>
          </form>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm" id="import-paper-folder-label">
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
                className="w-52"
              >
                <SelectValue>
                  {smart
                    ? `${smart.name}（智能标签）`
                    : folder
                      ? folder.slice(7).replaceAll("/", " / ")
                      : "不放入分类"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不放入分类</SelectItem>
                {categories.map((name) => (
                  <SelectItem key={name} value={`folder:${name}`}>
                    {name.replaceAll("/", " / ")}
                  </SelectItem>
                ))}
                {smartCategories.map((item) => (
                  <SelectItem
                    key={`smart:${item.id}`}
                    value={`smart:${item.id}`}
                  >
                    {item.name}（智能标签）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>
        <Separator />
        <section className="grid gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            从其他软件迁移
          </h3>
          <div className="grid grid-cols-2 gap-2">
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
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
