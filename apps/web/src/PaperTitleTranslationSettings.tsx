import { useState } from "react";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";

export function PaperTitleTranslationSettings() {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");

  const start = async () => {
    if (running) return;
    setRunning(true);
    setMessage("");
    try {
      const { translated, failed } = await api.backfillPaperTitles();
      const result = translated ? `已补译 ${translated} 篇` : "没有新增译名";
      setMessage(failed ? `${result}，${failed} 篇失败，可重试。` : `${result}。`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <h3 className="text-sm font-medium">补译论文标题</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            为论文库中缺少译名的论文生成简体中文译名，不覆盖已有译名。
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          disabled={running}
          onClick={() => void start()}
        >
          {running ? "正在补译…" : "开始补译"}
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}
