import { useEffect, useRef, useState } from "react";
import { Check, FileSearch, Pause, RotateCcw, Languages } from "lucide-react";
import type { Processing } from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@neoread/ui/components/alert-dialog";
import { toast } from "sonner";

type Action = "start" | "pause" | "resume";

/**
 * Papers translate the whole document with start, pause and resume. Books use
 * BookChapterControls, bound to the current chapter.
 */
export function AssistanceControls({
  documentId,
  processing,
}: {
  documentId: string;
  processing?: Processing;
}) {
  const [saved, setSaved] = useState<Processing>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const serial = useRef(0);
  const job =
    saved &&
    (!processing ||
      Date.parse(saved.updatedAt) > Date.parse(processing.updatedAt))
      ? saved
      : processing;
  useEffect(() => {
    let alive = true;
    setSaved(undefined);
    setBusy(false);
    setConfirming(false);
    void api
      .assistance(documentId)
      .then((p) => {
        if (alive) setSaved(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
      serial.current++;
    };
  }, [documentId]);
  const complete = job?.status === "complete";
  const paperParsing =
    job?.phase === "learning" && !job.retranslating && !complete;
  const parsingPending = paperParsing && job.status !== "failed";
  const [action, label]: [Action, string] =
    job?.enabled && job.status === "failed"
      ? ["resume", "重试翻译"]
      : job?.enabled && !complete
        ? ["pause", "暂停翻译"]
        : !job?.enabled
          ? job?.startedAt && !job.manualTranslation
            ? ["resume", "继续翻译"]
            : ["start", "翻译"]
          : ["start", "翻译完成"];
  const finished = complete;
  const actionLabel = paperParsing
    ? job.status === "failed"
      ? "重试解析"
      : job.status === "running"
        ? "解析中"
        : "等待解析"
    : job?.retranslating
      ? action === "pause"
        ? "暂停重译"
        : "继续重译"
      : label;
  const run = () => api.setAssistance(documentId, action);
  return (
    <div className="assistance-controls">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !job || finished || parsingPending}
        title={job?.enabled ? job.detail : "使用当前 AI 连接翻译全文与公式"}
        onClick={async () => {
          const operation = ++serial.current;
          setBusy(true);
          try {
            const next = await run();
            if (next && operation === serial.current) setSaved(next);
          } catch (e) {
            if (operation === serial.current) toast.error((e as Error).message);
          } finally {
            if (operation === serial.current) setBusy(false);
          }
        }}
      >
        {parsingPending ? (
          <FileSearch />
        ) : finished ? (
          <Check />
        ) : action === "pause" ? (
          <Pause />
        ) : action === "resume" && job?.status === "failed" ? (
          <RotateCcw />
        ) : (
          <Languages />
        )}
        {actionLabel}
      </Button>
      {finished && (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                title="重新翻译"
                aria-label="重新翻译"
              />
            }
          >
            <RotateCcw />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重新翻译全文？</AlertDialogTitle>
              <AlertDialogDescription>
                将重新解析全文版面，并使用当前 Agent
                翻译模型和已保存的翻译提示词重新翻译。解析成功前保留现有内容；仍能对应原文的旧译文会在新结果完成后逐段替换。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <Button
                disabled={busy}
                onClick={async () => {
                  const operation = ++serial.current;
                  setBusy(true);
                  try {
                    const next = await api.setAssistance(
                      documentId,
                      "retranslate",
                    );
                    if (operation === serial.current) {
                      setConfirming(false);
                      setSaved(next);
                    }
                  } catch (e) {
                    if (operation === serial.current)
                      toast.error((e as Error).message);
                  } finally {
                    if (operation === serial.current) setBusy(false);
                  }
                }}
              >
                {busy ? "正在开始…" : "开始重新翻译"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
