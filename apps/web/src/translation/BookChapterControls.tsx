import { useEffect, useRef, useState } from "react";
import { Check, Languages, Pause, RotateCcw } from "lucide-react";
import type { Processing } from "@neoread/core";
import { api, type ChapterTranslationStatus } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";
import { toast } from "sonner";
import { chapterPhase } from "./chapterTranslation";
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

/**
 * Book translation controls bound to the reader's current chapter: translate,
 * pause, continue, or a completion check naming the chapter.
 */
export function BookChapterControls({
  documentId,
  processing,
  status,
  stale = false,
  title,
  onRequest,
  onChange,
}: {
  documentId: string;
  processing?: Processing;
  /** Counts of the current chapter; undefined while it is resolved. */
  status?: ChapterTranslationStatus;
  /** The counts belong to an earlier anchor and are being refetched. */
  stale?: boolean;
  /** Chapter name for the completion tooltip, overriding the server title. */
  title?: string;
  /** Queues unfinished paragraphs, or explicitly retranslates the chapter. */
  onRequest: (retranslate?: boolean) => Promise<void>;
  /** Called after an action so the chapter counts are refetched. */
  onChange: () => void;
}) {
  const [saved, setSaved] = useState<Processing>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const serial = useRef(0);
  useEffect(() => {
    setSaved(undefined);
    setBusy(false);
    setConfirming(false);
    return () => {
      serial.current++;
    };
  }, [documentId]);
  const job =
    saved &&
    (!processing ||
      Date.parse(saved.updatedAt) > Date.parse(processing.updatedAt))
      ? saved
      : processing;
  const phase = status
    ? chapterPhase(status, job?.enabled === true)
    : undefined;
  useEffect(() => setConfirming(false), [status?.key]);
  const act = async (run: () => Promise<unknown>) => {
    const operation = ++serial.current;
    setBusy(true);
    try {
      await run();
      const next = await api.assistance(documentId);
      if (operation === serial.current) setSaved(next);
    } catch (e) {
      if (operation === serial.current) toast.error((e as Error).message);
    } finally {
      if (operation === serial.current) setBusy(false);
      onChange();
    }
  };
  if (phase === "complete") {
    const name = title || status?.title;
    const label = name ? `翻译完成：${name}` : "翻译完成";
    return (
      <div className="assistance-controls">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                aria-disabled
                className="cursor-default"
              />
            }
          >
            <Check aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy || stale}
                title="重新翻译本章"
                aria-label="重新翻译本章"
              />
            }
          >
            <RotateCcw aria-hidden="true" />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重新翻译本章？</AlertDialogTitle>
              <AlertDialogDescription>
                将使用当前翻译模型和已保存的翻译提示词重新翻译本章。旧译文会在新结果完成后逐段替换。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <Button
                disabled={busy || stale}
                onClick={() =>
                  void act(async () => {
                    await onRequest(true);
                    setConfirming(false);
                  })
                }
              >
                {busy ? "正在开始…" : "开始重新翻译"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }
  // Saved scopes without a kind predate chapter scopes.
  const paragraphTask =
    !!job?.translationBlocks?.length && job.translationScopeKind !== "chapter";
  const action = paragraphTask && phase ? "untranslated" : phase;
  const working = action === "translating";
  return (
    <div className="assistance-controls">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || stale || !phase}
        title={working ? undefined : "翻译当前完整章节，复用已完成译文"}
        onClick={() =>
          void act(
            working ? () => api.setAssistance(documentId, "pause") : onRequest,
          )
        }
      >
        {working ? <Pause /> : <Languages />}
        {working ? "暂停翻译" : action === "paused" ? "继续翻译" : "翻译本章"}
      </Button>
    </div>
  );
}
