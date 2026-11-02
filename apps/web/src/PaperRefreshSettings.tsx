import { useEffect, useRef, useState } from "react";
import { api, type PaperRefreshProgress } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { LoaderCircle } from "lucide-react";
import { refreshLibrary } from "./store";

export function PaperRefreshSettings({ open }: { open: boolean }) {
  const [progress, setProgress] = useState<PaperRefreshProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await api.paperRefreshStatus();
        if (!active) return;
        if (running.current && next.status !== "running")
          void refreshLibrary().catch(() => {});
        running.current = next.status === "running";
        setProgress(next);
        setError("");
      } catch {
        if (active) setError("无法读取任务状态，请稍后重试。");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open]);
  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const next = await api.startPaperRefresh();
      running.current = next.status === "running";
      setProgress(next);
    } catch {
      setError("无法启动任务，请稍后重试。");
    } finally {
      setStarting(false);
    }
  };
  const busy = starting || progress?.status === "running";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <h3 className="text-sm font-medium">
            重新识别论文标题，并查找论文信息
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            处理出处为空且标题未手动编辑过的 PDF 论文。AI
            标题会显示为建议，供你确认。
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          disabled={busy || !progress}
          onClick={() => void start()}
        >
          {busy && (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          )}
          {busy ? "进行中…" : "开始"}
        </Button>
      </div>

      {progress && progress.status !== "idle" && (
        <p role="status" className="text-xs text-muted-foreground">
          {progress.status === "running"
            ? "正在处理"
            : progress.status === "interrupted"
              ? "任务已中断"
              : "处理完成"}
          ：{progress.processed}/{progress.total} 篇
          {progress.failed > 0 && `，${progress.failed} 篇未完成`}
          {progress.skipped > 0 && `，${progress.skipped} 篇跳过`}
        </p>
      )}
      {error && (
        <p role="status" className="text-xs text-muted-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
