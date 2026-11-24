import { reportDiagnostic } from "./diagnostics";
import { useEffect, useId, useRef, useState } from "react";
import {
  neoreadLink,
  type Annotation,
  type Document,
  type DocumentChatSession,
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
import type { ChatExportSession } from "./notes-export";
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
  chat: "Agent 对话",
} satisfies Record<ExportTarget, string>;
const formatLabels = {
  markdown: "Markdown",
  pdf: "PDF",
  zip: "含图ZIP",
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
  link,
  onClose,
}: {
  document: Document;
  annotations?: Annotation[];
  link?: (annotation: Annotation) => string;
  onClose: () => void;
}) {
  const [kinds, setKinds] = useState(savedKinds);
  const [targets, setTargets] = useState<ExportTarget[]>(["original"]);
  const [formats, setFormats] = useState<DialogFormat[]>(["markdown"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<DocumentChatSession[]>();
  const [excludedSessions, setExcludedSessions] = useState<Set<string>>(
    () => new Set(),
  );
  const [sessionsError, setSessionsError] = useState("");
  const sessionControlPrefix = useId();
  const chatSelected = targets.includes("chat");
  useEffect(() => {
    if (!chatSelected || sessions || sessionsError) return;
    const controller = new AbortController();
    void api.chatSessions(doc.id, controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setSessions(list);
      },
      () => {
        if (!controller.signal.aborted) setSessionsError("无法读取会话");
      },
    );
    return () => controller.abort();
  }, [chatSelected, doc.id, sessions, sessionsError]);
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
  const selectedSessions = sessions?.filter(
    ({ id }) => !excludedSessions.has(id),
  );
  const chatUnavailable = chatSelected && !selectedSessions?.length;
  const noteTargets = targets.filter((target) => !isSource(target));
  const save = async (action: "download" | "copy") => {
    if (
      (action === "download" ? !formats.length : !noteTargets.length) ||
      !targets.length ||
      request.current ||
      annotationsUnavailable ||
      chatUnavailable
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    let savedCount = 0;
    let annotationData: Promise<[Annotation[], Message[]]> | undefined;
    let paperNoteData: Promise<string> | undefined;
    const sessionMessages = new Map<string, Promise<Message[]>>();
    const messagesFor = (id: string) => {
      let messages = sessionMessages.get(id);
      if (!messages) {
        messages = api.sessionMessages(doc.id, id, controller.signal);
        sessionMessages.set(id, messages);
      }
      return messages;
    };
    const loadAnnotations = async (): Promise<[Annotation[], Message[]]> => {
      const marks =
        annotations ?? (await api.annotations(doc.id, controller.signal));
      const answerIds = new Set(
        kinds.includes("question")
          ? marks.flatMap((mark) =>
              mark.kind === "question" && mark.answerId ? [mark.answerId] : [],
            )
          : [],
      );
      if (!answerIds.size) return [marks, []];
      controller.signal.throwIfAborted();
      const allSessions =
        sessions ?? (await api.chatSessions(doc.id, controller.signal));
      controller.signal.throwIfAborted();
      const histories = await Promise.all(
        allSessions.map(({ id }) => messagesFor(id)),
      );
      return [
        marks,
        histories.flatMap((history) =>
          history.filter((message) => answerIds.has(message.id)),
        ),
      ];
    };
    let chatData: Promise<ChatExportSession[]> | undefined;
    const loadChat = async () => {
      const conversations = await Promise.all(
        (selectedSessions ?? []).map(async ({ id, title, createdAt }) => ({
          title,
          createdAt,
          messages: await messagesFor(id),
        })),
      );
      if (!conversations.some(({ messages }) => messages.length))
        throw new Error("没有可导出的 Agent 对话");
      return conversations;
    };
    const notesFor = async (
      selected: ExportTarget[],
      includeTitle: boolean,
    ) => {
      const [marks, paperNote, chat] = await Promise.all([
        selected.includes("annotations")
          ? (annotationData ??= loadAnnotations())
          : undefined,
        selected.includes("paperNote")
          ? (paperNoteData ??= readPaperNote(doc.id))
          : "",
        selected.includes("chat") ? (chatData ??= loadChat()) : undefined,
      ]);
      controller.signal.throwIfAborted();
      if (
        marks &&
        !marks[0].some((a) => kinds.includes(a.kind as AnnotationExportKind))
      )
        throw new Error("没有可导出的批注");
      if (!marks && !chat && !paperNote.trim())
        throw new Error("没有可导出的论文笔记");
      return selectedNotesMarkdown(
        doc,
        marks?.[0] ?? [],
        marks?.[1] ?? [],
        kinds,
        link ?? ((a) => neoreadLink({ id: doc.id, annotation: a.id })),
        { paperNote, chat, includeTitle },
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
        {chatSelected && (
          <div
            className="max-h-[min(12rem,25dvh)] overflow-y-auto px-1 scrollbar-none"
            role="group"
            aria-label="选择对话"
          >
            {sessionsError ? (
              <div className="flex items-center gap-2">
                <p role="alert" className="text-sm text-destructive">
                  {sessionsError}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSessionsError("")}
                >
                  重试
                </Button>
              </div>
            ) : !sessions ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取会话…
              </p>
            ) : sessions.length ? (
              sessions.map(({ id, title }) => (
                <label
                  key={id}
                  htmlFor={`${sessionControlPrefix}-${id}`}
                  className="flex min-h-11 items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={`${sessionControlPrefix}-${id}`}
                    checked={!excludedSessions.has(id)}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setExcludedSessions((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 truncate" title={title}>
                    {title}
                  </span>
                </label>
              ))
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                暂无对话
              </p>
            )}
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
            disabled={busy || annotationsUnavailable || chatUnavailable}
            onClick={() => void save("copy")}
          >
            复制 Markdown
          </Button>
        )}
        <Button
          className="h-10 w-full gap-2 rounded-full"
          disabled={
            busy ||
            !formats.length ||
            !targets.length ||
            annotationsUnavailable ||
            chatUnavailable
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
