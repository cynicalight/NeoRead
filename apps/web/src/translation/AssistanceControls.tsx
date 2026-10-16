import { useEffect, useRef, useState } from "react";
import { Pause, RotateCcw, Languages } from "lucide-react";
import type { EPUBLocation, LibraryMode, Processing } from "@reader/core";
import { api } from "@reader/api";
import { Button } from "@reader/ui/components/button";
import { toast } from "sonner";
import type { PageRange } from "./chapters";

type Action = "start" | "pause" | "resume" | "chapter";

/**
 * Papers translate the whole document with start, pause and resume. Books
 * translate the current chapter on request; the server caps each request.
 */
export function AssistanceControls({
  documentId,
  processing,
  library = "papers",
  chapter,
  epubChapter,
}: {
  documentId: string;
  processing?: Processing;
  library?: LibraryMode;
  /** The chapter at the reading position, read when the button is pressed. */
  chapter?: () => PageRange | undefined;
  epubChapter?: () => EPUBLocation | undefined;
}) {
  const [saved, setSaved] = useState<Processing>();
  const [busy, setBusy] = useState(false);
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
  const [action, label]: [Action, string] =
    job?.enabled && job.status === "failed"
      ? ["resume", "重试翻译"]
      : job?.enabled && !complete
        ? ["pause", "暂停翻译"]
        : !job?.enabled
          ? epubChapter &&
            (!job?.startedAt || job.translating?.status === "complete")
            ? ["chapter", "翻译本章"]
            : job?.startedAt && !job.manualTranslation
              ? ["resume", "继续翻译"]
              : ["start", "翻译"]
          : library === "books"
            ? ["chapter", "翻译本章"]
            : ["start", "翻译完成"];
  const finished = complete && action !== "chapter";
  const run = async () => {
    if (action !== "chapter") return api.setAssistance(documentId, action);
    if (epubChapter) {
      const location = epubChapter();
      if (!location?.href) throw new Error("正文仍在加载，请稍后再试");
      const result = await api.translateEPUBChapter(documentId, location);
      if (result.hasMore) toast("本章较长，完成后可再次点击翻译本章继续");
      return api.assistance(documentId);
    }
    const range = chapter?.();
    if (!range) return undefined;
    const result = await api.translateRange(
      documentId,
      range.fromPage,
      range.toPage,
    );
    if (result.parsing) toast("正在解析本章，完成后开始翻译");
    else if (!result.queued) toast("本章已翻译");
    else if (result.nextPage)
      toast(
        `本章较长，本次翻译至第 ${result.nextPage} 页，完成后可再次翻译本章`,
      );
    return api.assistance(documentId);
  };
  return (
    <div className="assistance-controls">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !job || finished}
        title={
          action === "chapter"
            ? "翻译当前章节，单次最多约 4 万字"
            : job?.enabled
              ? job.detail
              : epubChapter
                ? "继续已请求章节的翻译"
                : "使用当前 AI 连接翻译全文与公式"
        }
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
        {action === "pause" ? (
          <Pause />
        ) : action === "resume" && job?.status === "failed" ? (
          <RotateCcw />
        ) : (
          <Languages />
        )}
        {label}
      </Button>
    </div>
  );
}
