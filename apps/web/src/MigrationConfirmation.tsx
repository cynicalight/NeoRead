import { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@neoread/ui/components/alert-dialog";
import "./style.css";

declare global {
  interface Window {
    neoreadMigration?: { decide(confirmed: boolean): void };
  }
}

export function MigrationConfirmation() {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resume = new URLSearchParams(location.search).has("resume");
  const [pending, setPending] = useState(false);
  const [previewResult, setPreviewResult] = useState("");
  useEffect(() => {
    const theme = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle("dark", theme.matches);
    apply();
    theme.addEventListener("change", apply);
    return () => theme.removeEventListener("change", apply);
  }, []);
  const decide = (confirmed: boolean) => {
    if (pending) return;
    if (!window.neoreadMigration) {
      setPreviewResult(
        confirmed
          ? "预览：已确认迁移，未操作数据。"
          : "预览：已跳过迁移，将继续启动。",
      );
      return;
    }
    setPending(true);
    window.neoreadMigration.decide(confirmed);
  };
  return (
    <>
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) decide(false);
        }}
      >
        <AlertDialogContent initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resume ? "继续迁移 Reader 数据？" : "迁移 Reader 数据？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resume
                ? "上次迁移尚未完成。确认后将继续迁移，并校验已复制的数据。"
                : "检测到旧 Reader 的书库或配置。确认后将复制到 NeoRead，并校验迁移结果。"}
              <br />
              迁移是可选的，旧数据会保留。可以跳过并继续使用
              NeoRead，之后在设置中自行导入或迁移书库。迁移前请先退出旧 Reader。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} disabled={pending}>
              暂不迁移
            </AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={() => decide(true)}>
              {resume ? "继续迁移" : "迁移并启动"}
            </AlertDialogAction>
          </AlertDialogFooter>
          {previewResult && (
            <p role="status" className="text-sm text-muted-foreground">
              {previewResult}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<MigrationConfirmation />);
