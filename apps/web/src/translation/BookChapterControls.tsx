import { useEffect, useRef, useState } from "react";
import { Check, Languages, Pause } from "lucide-react";
import type { Processing } from "@neoread/core";
import { api, type ChapterTranslationStatus } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";
import { toast } from "sonner";
import { chapterPhase, type ChapterPhase } from "./chapterTranslation";

/** How long "翻译完成" stays labelled before collapsing to its check. */
export const completionLabelMs = 3000;

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
  /** Queues the current chapter's unfinished paragraphs. */
  onRequest: () => Promise<void>;
  /** Called after an action so the chapter counts are refetched. */
  onChange: () => void;
}) {
  const [saved, setSaved] = useState<Processing>();
  const [busy, setBusy] = useState(false);
  const serial = useRef(0);
  useEffect(() => {
    setSaved(undefined);
    setBusy(false);
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
  // Name completion only when it happens in view; an already finished
  // chapter shows the check alone.
  const [announce, setAnnounce] = useState(false);
  const seen = useRef<{ key: string; phase?: ChapterPhase }>({ key: "" });
  useEffect(() => {
    const previous = seen.current;
    const key = status?.key ?? "";
    seen.current = { key, phase };
    if (
      phase !== "complete" ||
      previous.key !== key ||
      !previous.phase ||
      previous.phase === "complete"
    ) {
      if (phase !== "complete" || previous.key !== key) setAnnounce(false);
      return;
    }
    setAnnounce(true);
  }, [status?.key, phase]);
  useEffect(() => {
    if (!announce) return;
    const timer = setTimeout(() => setAnnounce(false), completionLabelMs);
    return () => clearTimeout(timer);
  }, [announce]);
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
                size={announce ? "sm" : "icon-sm"}
                aria-label={label}
                aria-disabled
                className="cursor-default"
              />
            }
          >
            <Check />
            {announce && "翻译完成"}
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </div>
    );
  }
  const working = phase === "translating";
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
        {working ? "暂停翻译" : phase === "paused" ? "继续翻译" : "翻译本章"}
      </Button>
    </div>
  );
}
