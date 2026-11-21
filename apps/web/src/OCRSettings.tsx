import { useEffect, useState } from "react";
import { CircleCheck, Download, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { Progress } from "@neoread/ui/components/progress";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import {
  megabytes,
  modelSize,
  refreshOCR,
  runOCRAction,
  useOCRStore,
  type OCRUserAction,
} from "./ocr";

/** The OCR section of the reading settings; notifications deep-link here. */
export function OCRSettings({ open }: { open: boolean }) {
  const status = useOCRStore((s) => s.status);
  const error = useOCRStore((s) => s.error);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) void refreshOCR(true);
  }, [open]);
  const run = async (action: OCRUserAction) => {
    setBusy(true);
    await runOCRAction(action);
    setBusy(false);
  };
  const ready = status?.modelState === "ready";
  const percent =
    status && status.totalBytes > 0
      ? Math.min(100, (status.downloadedBytes / status.totalBytes) * 100)
      : null;
  return (
    <section id="settings-ocr" tabIndex={-1} className="space-y-3 outline-none">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id="ocr-label" className="text-sm font-medium">
            文字识别
          </h3>
          <p
            id="ocr-description"
            className="text-xs leading-5 text-muted-foreground"
          >
            为 PDF
            中的扫描页识别文字，不修改原文件；已有可选中文字的页面不会重复识别。
          </p>
        </div>
        {status?.systemAvailable && (
          <Tabs
            className="shrink-0"
            value={status.engine === "paddle" ? "paddle" : "system"}
            onValueChange={(value) =>
              void run(value === "paddle" ? "use-paddle" : "use-system")
            }
          >
            <TabsList
              aria-labelledby="ocr-label"
              aria-describedby="ocr-description"
            >
              <TabsTrigger value="system" disabled={busy}>
                系统
              </TabsTrigger>
              <TabsTrigger value="paddle" disabled={busy || !ready}>
                PaddleOCR
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>
      {!status ? (
        <p className="text-xs text-muted-foreground" role="status">
          {error ? `文字识别状态暂时不可用：${error}` : "正在读取…"}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <span>PaddleOCR 模型</span>
              <span className="block text-xs text-muted-foreground">
                {status.modelState === "ready"
                  ? status.engine === "paddle"
                    ? "已安装，正在使用"
                    : "已安装"
                  : status.modelState === "failed"
                    ? "下载失败，请检查网络后重试"
                    : status.modelState === "downloading"
                      ? percent === null
                        ? "正在下载…"
                        : `正在下载 ${megabytes(status.downloadedBytes)} / ${megabytes(status.totalBytes)} MB`
                      : status.systemAvailable
                        ? `可选，${modelSize(status)}。仅在点击下载时联网`
                        : `本机没有系统文字识别，需下载模型（${modelSize(status)}）后才能识别扫描页`}
              </span>
            </div>
            {status.modelState === "ready" ? (
              <CircleCheck
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : status.modelState === "downloading" ? (
              <LoaderCircle
                className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy}
                onClick={() => void run("download")}
              >
                {status.modelState === "failed" ? <RotateCcw /> : <Download />}
                {status.modelState === "failed" ? "重试" : "下载"}
              </Button>
            )}
          </div>
          {status.modelState === "downloading" && (
            <Progress
              value={percent}
              aria-label="PaddleOCR 模型下载进度"
              getAriaValueText={(_, value) =>
                value === null ? "正在下载" : `${Math.round(value)}%`
              }
            />
          )}
          {ready && (
            <p className="text-xs leading-5 text-muted-foreground">
              切换引擎不会改动已解析的文档；需要时在文档菜单中选择“重新解析”。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
