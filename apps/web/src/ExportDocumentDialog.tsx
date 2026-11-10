import { reportDiagnostic } from "./diagnostics";
import { useEffect, useRef, useState } from "react";
import {
  neoreadLink,
  type Annotation,
  type Document,
  type Message,
} from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Toggle } from "@neoread/ui/components/toggle";
import { Checkbox } from "@neoread/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import { Check, Download, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { saveExportBlob, exportCancelled, fileTitle } from "./download";
import { exportTranslatedPDF } from "./translated-pdf-export";
import {
  annotationExportKinds,
  annotationMarkdown,
  exportMarkdownFile,
  exportOriginal,
  type AnnotationExportKind,
  type ExportFormat,
  type ExportTarget,
} from "./document-export";

const storageKey = "neoread.annotation-export-kinds";
const allKinds = Object.keys(annotationExportKinds) as AnnotationExportKind[];
function savedKinds(): AnnotationExportKind[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "");
    if (Array.isArray(value))
      return value.filter((item): item is AnnotationExportKind =>
        allKinds.includes(item),
      );
  } catch {
    /* Use all kinds initially. */
  }
  return allKinds;
}

export function ExportDocumentDialog({
  document: doc,
  annotations,
  messages,
  link,
  onClose,
}: {
  document: Document;
  annotations?: Annotation[];
  messages?: Message[];
  link?: (annotation: Annotation) => string;
  onClose: () => void;
}) {
  const [kinds, setKinds] = useState(savedKinds);
  const [targets, setTargets] = useState<ExportTarget[]>(["original"]);
  const [formats, setFormats] = useState<ExportFormat[]>(["markdown"]);
  const [busy, setBusy] = useState<ExportTarget | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [doc.id],
  );
  const close = () => {
    request.current?.abort();
    onClose();
  };
  const toggle = (kind: AnnotationExportKind, checked: boolean) => {
    const next = checked
      ? [...kinds, kind]
      : kinds.filter((item) => item !== kind);
    setKinds(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Session only. */
    }
  };
  const hasAnnotations =
    kinds.length > 0 &&
    (!annotations ||
      annotations.some((a) => kinds.includes(a.kind as AnnotationExportKind)));
  const save = async () => {
    if (
      !formats.length ||
      !targets.length ||
      request.current ||
      (targets.includes("annotations") && !hasAnnotations)
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(targets[0]);
    setError("");
    let savedCount = 0;
    let exportAnnotations = annotations;
    let exportMessages = messages;
    try {
      for (const selection of targets) {
        setBusy(selection);
        for (const format of formats) {
          if (controller.signal.aborted) return;
          const requestId = crypto.randomUUID();
          const started = performance.now();
          const report = (stage: string) =>
            reportDiagnostic({
              level: stage === "failed" ? "error" : "info",
              event: `document.export.${stage}`,
              requestId,
              durationMs: Math.round(performance.now() - started),
              detail: `target=${selection} format=${format}`,
            });
          report("start");
          try {
            let delivery: "download" | "print" = "download";
            if (selection === "original")
              delivery = await exportOriginal(doc, format, controller.signal);
            else if (selection === "translation") {
              if (format === "pdf")
                delivery = (
                  await exportTranslatedPDF(doc, controller.signal, () => {})
                ).delivery;
              else {
                const blob = await api.exportTranslation(
                  doc.id,
                  "markdown",
                  controller.signal,
                );
                controller.signal.throwIfAborted();
                await saveExportBlob(
                  blob,
                  `${fileTitle(doc.title)}-译文.md`,
                  controller.signal,
                );
              }
            } else {
              if (!exportAnnotations || !exportMessages) {
                [exportAnnotations, exportMessages] = await Promise.all([
                  exportAnnotations ??
                    api.annotations(doc.id, controller.signal),
                  exportMessages ?? api.messages(doc.id, controller.signal),
                ]);
                controller.signal.throwIfAborted();
              }
              if (
                !exportAnnotations.some((a) =>
                  kinds.includes(a.kind as AnnotationExportKind),
                )
              )
                throw new Error("没有可导出的批注");
              delivery = await exportMarkdownFile(
                annotationMarkdown(
                  doc,
                  exportAnnotations,
                  exportMessages,
                  kinds,
                  link ??
                    ((a) => neoreadLink({ id: doc.id, annotation: a.id })),
                ),
                `${fileTitle(doc.title)}-批注`,
                format,
                controller.signal,
              );
            }
            if (!controller.signal.aborted) {
              report(
                delivery === "download"
                  ? window.neoreadDesktop?.saveExportFile
                    ? "saved"
                    : "download_requested"
                  : "print_dialog_closed",
              );
              if (delivery === "download") savedCount++;
            }
          } catch (error) {
            if (exportCancelled(error, controller.signal)) {
              controller.abort();
              toast.info(
                savedCount
                  ? `已取消导出，已保存 ${savedCount} 个文件`
                  : "已取消导出",
              );
              return;
            }
            if (!controller.signal.aborted) report("failed");
            if (!controller.signal.aborted)
              setError(
                error instanceof Error ? error.message : "导出失败，请重试",
              );
            return;
          } finally {
            if (controller.signal.aborted) report("cancelled");
          }
        }
      }
      if (!controller.signal.aborted) {
        if (savedCount)
          toast.success(
            window.neoreadDesktop?.saveExportFile
              ? `已保存 ${savedCount} 个文件`
              : `已发起 ${savedCount} 个文件的下载`,
          );
        onClose();
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  };
  const targetLabels: Record<ExportTarget, string> = {
    annotations: "批注",
    original: "原文",
    translation: "译文",
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>导出</DialogTitle>
        </DialogHeader>
        <div
          className="grid grid-cols-3 gap-2"
          role="group"
          aria-label="导出内容"
        >
          {(["annotations", "original", "translation"] as const).map(
            (selection) => (
              <Toggle
                key={selection}
                variant="outline"
                pressed={targets.includes(selection)}
                disabled={!!busy}
                onPressedChange={(pressed) =>
                  setTargets((current) =>
                    pressed
                      ? [...current, selection]
                      : current.filter((item) => item !== selection),
                  )
                }
                className="flex-1 aria-pressed:border-emerald-300 aria-pressed:bg-emerald-100 aria-pressed:text-emerald-900 dark:aria-pressed:border-emerald-500/40 dark:aria-pressed:bg-emerald-500/20 dark:aria-pressed:text-emerald-200"
              >
                {targets.includes(selection) && <Check aria-hidden="true" />}
                {targetLabels[selection]}
              </Toggle>
            ),
          )}
        </div>
        {targets.includes("annotations") && (
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            {allKinds.map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label={annotationExportKinds[kind]}
                  checked={kinds.includes(kind)}
                  disabled={!!busy}
                  onCheckedChange={(checked) => toggle(kind, !!checked)}
                />
                {annotationExportKinds[kind]}
              </label>
            ))}
          </div>
        )}
        <div className="flex gap-2" role="group" aria-label="导出格式">
          {(["markdown", "pdf"] as const).map((format) => (
            <Toggle
              key={format}
              variant="outline"
              pressed={formats.includes(format)}
              disabled={!!busy}
              onPressedChange={(pressed) =>
                setFormats((current) =>
                  pressed
                    ? [...current, format]
                    : current.filter((item) => item !== format),
                )
              }
              className="flex-1 aria-pressed:border-emerald-300 aria-pressed:bg-emerald-100 aria-pressed:text-emerald-900 dark:aria-pressed:border-emerald-500/40 dark:aria-pressed:bg-emerald-500/20 dark:aria-pressed:text-emerald-200"
            >
              {formats.includes(format) && <Check aria-hidden="true" />}
              {format === "markdown" ? "Markdown" : "PDF"}
            </Toggle>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          className="h-10 w-full gap-2 rounded-full"
          disabled={
            !!busy ||
            !formats.length ||
            !targets.length ||
            (targets.includes("annotations") && !hasAnnotations)
          }
          onClick={() => void save()}
        >
          {busy ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="size-4" />
          )}
          导出
        </Button>
      </DialogContent>
    </Dialog>
  );
}
