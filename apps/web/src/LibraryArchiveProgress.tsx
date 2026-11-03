import { LoaderCircle } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  switchImportedLibrary,
  useLibraryArchiveTask,
} from "./library-archive-task";

export function LibraryArchiveProgress({
  onBackground,
}: {
  onBackground: () => void;
}) {
  const task = useLibraryArchiveTask();
  if (!task.kind || task.phase === "idle" || task.phase === "selecting")
    return null;
  const working = task.phase === "running" || task.phase === "switching";
  const title =
    task.phase === "ready"
      ? "书库已导入"
      : task.phase === "failed"
        ? "书库操作失败"
        : task.phase === "switching"
          ? "正在切换书库"
          : task.kind === "export"
            ? "正在导出书库"
            : "正在导入书库";
  const background = () => {
    useLibraryArchiveTask.setState(
      task.phase === "failed"
        ? { foreground: false, kind: null, phase: "idle" }
        : { foreground: false },
    );
    onBackground();
  };
  return (
    <>
      {!task.foreground && (
        <div className="library-archive-status" role="status">
          {working && (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          )}
          <span>{title}</span>
          {task.phase === "ready" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void switchImportedLibrary()}
            >
              切换到新书库
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                useLibraryArchiveTask.setState({ foreground: true })
              }
            >
              查看
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={task.foreground}
        onOpenChange={(open) => {
          if (!open) background();
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {task.phase === "ready"
              ? "可以切换到导入后的书库，当前阅读状态会先保存。"
              : task.phase === "failed"
                ? task.error
                : task.phase === "switching"
                  ? "正在保存阅读状态并加载书库。"
                  : "可以转到后台继续阅读，完成后会提示。后台导入完成后，可自行选择何时切换书库。"}
          </DialogDescription>
          {working && (
            <LoaderCircle
              aria-label="处理中"
              className="size-5 animate-spin motion-reduce:animate-none"
            />
          )}
          {task.error && task.phase !== "failed" && (
            <p role="alert" className="text-sm text-destructive">
              {task.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={task.phase === "switching"}
              onClick={background}
            >
              {task.phase === "failed" ? "关闭" : "后台运行"}
            </Button>
            {task.phase === "ready" && (
              <Button onClick={() => void switchImportedLibrary()}>
                切换到新书库
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
