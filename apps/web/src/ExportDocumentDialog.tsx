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
import { copyText } from "./chat/clipboard";
import { readPaperNote } from "./paper-note-state";
import { exportTranslatedPDF } from "./translated-pdf-export";
import {
  annotationExportKinds,
  selectedNotesMarkdown,
  exportMarkdownFile,
  exportOriginal,
  type AnnotationExportKind,
  type ExportFormat,
  type ExportTarget,
} from "./document-export";

const targetLabels = {
  annotations: "批注",
  paperNote: "论文笔记",
  original: "原文",
  translation: "译文",
} satisfies Record<ExportTarget, string>;
const formatLabels = {
  markdown: "Markdown",
  pdf: "PDF",
  zip: "Markdown + 图片 (.zip)",
} satisfies Record<ExportFormat | "zip", string>;
type DialogFormat = keyof typeof formatLabels;
const isSource = (target: ExportTarget): target is "original" | "translation" =>
  target === "original" || target === "translation";

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
  const [formats, setFormats] = useState<DialogFormat[]>(["markdown"]);
  const [busy, setBusy] = useState(false);
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
  const annotationsUnavailable =
    targets.includes("annotations") && !hasAnnotations;
  const noteTargets = targets.filter((target) => !isSource(target));
  const save = async (action: "download" | "copy") => {
    if (
      (action === "download" ? !formats.length : !noteTargets.length) ||
      !targets.length ||
      request.current ||
      annotationsUnavailable
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    let savedCount = 0;
    let annotationData: Promise<[Annotation[], Message[]]> | undefined;
    let paperNoteData: Promise<string> | undefined;
    const notesFor = async (
      selected: ExportTarget[],
      includeTitle: boolean,
    ) => {
      const [marks, paperNote] = await Promise.all([
        selected.includes("annotations")
          ? (annotationData ??= Promise.all([
              annotations ?? api.annotations(doc.id, controller.signal),
              messages ?? api.messages(doc.id, controller.signal),
            ]))
          : undefined,
        selected.includes("paperNote")
          ? (paperNoteData ??= readPaperNote(doc.id))
          : "",
      ]);
      controller.signal.throwIfAborted();
      if (
        marks &&
        !marks[0].some((a) => kinds.includes(a.kind as AnnotationExportKind))
      )
        throw new Error("没有可导出的批注");
      if (!marks && !paperNote.trim()) throw new Error("没有可导出的论文笔记");
      return selectedNotesMarkdown(
        doc,
        marks?.[0] ?? [],
        marks?.[1] ?? [],
        kinds,
        link ?? ((a) => neoreadLink({ id: doc.id, annotation: a.id })),
        { paperNote, includeTitle },
      );
    };
    try {
      if (action === "copy") {
        try {
          const markdown = notesFor(noteTargets, true);
          if (
            !window.neoreadDesktop?.writeClipboardText &&
            typeof ClipboardItem === "function" &&
            navigator.clipboard?.write
          ) {
            // Pass the text promise immediately to retain the click's activation.
            const text = markdown.then(
              (value) => new Blob([value], { type: "text/plain" }),
            );
            await Promise.all([
              navigator.clipboard.write([
                new ClipboardItem({ "text/plain": text }),
              ]),
              text,
            ]);
            toast.success("已复制 Markdown", { id: "neoread-clipboard" });
          } else {
            await copyText(await markdown, "已复制 Markdown");
          }
        } catch (error) {
          if (!controller.signal.aborted)
            setError(
              error instanceof Error ? error.message : "复制失败，请重试",
            );
        }
        return;
      }
      for (const selection of targets) {
        for (const format of formats) {
          if (controller.signal.aborted) return;
          if (format === "zip" && selection !== targets[0]) continue;
          const requestId = crypto.randomUUID();
          const started = performance.now();
          const report = (stage: string) =>
            reportDiagnostic({
              level: stage === "failed" ? "error" : "info",
              event: `document.export.${stage}`,
              requestId,
              durationMs: Math.round(performance.now() - started),
              detail: `target=${format === "zip" ? "combined" : selection} format=${format}`,
            });
          report("start");
          try {
            let delivery: "download" | "print" = "download";
            if (format === "zip") {
              const sources = targets.filter(isSource);
              const notes = noteTargets.length
                ? await notesFor(noteTargets, sources.length === 0)
                : "";
              const blob = await api.exportMarkdownArchive(
                doc.id,
                sources,
                notes,
                controller.signal,
              );
              await saveExportBlob(
                blob,
                `${fileTitle(doc.title)}.zip`,
                controller.signal,
              );
            } else if (selection === "original")
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
              const markdown = await notesFor([selection], true);
              delivery = await exportMarkdownFile(
                markdown,
                `${fileTitle(doc.title)}-${targetLabels[selection]}`,
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
        setBusy(false);
      }
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>导出</DialogTitle>
        </DialogHeader>
        <div
          className="grid grid-cols-2 gap-2"
          role="group"
          aria-label="导出内容"
        >
          {(Object.keys(targetLabels) as ExportTarget[]).map((selection) => (
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
          ))}
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
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="导出格式"
        >
          {(Object.keys(formatLabels) as DialogFormat[]).map((format) => (
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
              {formatLabels[format]}
            </Toggle>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {noteTargets.length > 0 && (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || annotationsUnavailable}
            onClick={() => void save("copy")}
          >
            复制 Markdown
          </Button>
        )}
        <Button
          className="h-10 w-full gap-2 rounded-full"
          disabled={
            busy || !formats.length || !targets.length || annotationsUnavailable
          }
          onClick={() => void save("download")}
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
