import { useEffect, useState } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";

export function LibraryLocationSettings({
  open,
  recovery = false,
}: {
  open: boolean;
  recovery?: boolean;
}) {
  const desktop = window.neoreadDesktop;
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !desktop?.libraryLocation) return;
    let active = true;
    desktop.libraryLocation().then(
      (value) => {
        if (active) setDirectory(value);
      },
      (error) => {
        if (active) setError(error.message);
      },
    );
    return () => {
      active = false;
    };
  }, [open, desktop]);
  if (!desktop?.libraryLocation || !desktop.moveLibrary) return null;
  const move = async (existing = false) => {
    setImporting(existing);
    setBusy(true);
    setError("");
    try {
      if (existing) await desktop.importLibrary!();
      else await desktop.moveLibrary!();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium">书库位置</h3>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            disabled={recovery || !directory || busy}
            onClick={() => void move()}
            className="transition-transform active:scale-[0.98] motion-reduce:transform-none"
          >
            <FolderOpen />
            更改位置
          </Button>
          {desktop.importLibrary && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void move(true)}
            >
              <FolderOpen />
              导入书库
            </Button>
          )}
        </div>
      </div>
      <p className="mb-3 break-all text-xs leading-5 text-muted-foreground">
        {recovery ? "书库尚未连接" : directory || "正在读取位置"}
      </p>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        PDF、图书、笔记、批注和阅读记录一起保存。选择新位置后，将在该目录下新建
        NeoRead Library
        文件夹，复制整个书库并重启。原目录保留，已有文件不会被覆盖。
      </p>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        导入书库：选择包含 neoread.sqlite 或 reader.sqlite 的 library
        文件夹，直接打开已有书库，不合并数据。
      </p>
      {error && (
        <p
          role="alert"
          className="mt-3 text-xs text-destructive animate-in fade-in-0 motion-reduce:animate-none"
        >
          {error}
        </p>
      )}
      <Dialog open={busy} onOpenChange={(_, details) => details.cancel()}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>
            {importing ? "正在导入书库" : "正在更改书库位置"}
          </DialogTitle>
          <DialogDescription>
            请完成目录选择和确认。处理过程中请保持 NeoRead
            打开，完成后会自动重启。
          </DialogDescription>
          <LoaderCircle
            aria-label="处理中"
            className="size-5 animate-spin motion-reduce:animate-none"
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
