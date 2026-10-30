import { useEffect, useRef, useState } from "react";
import { Copy, Download, FileDown, LoaderCircle } from "lucide-react";
import type { Annotation, Document, Message } from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Checkbox } from "@neoread/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import { copyText } from "./chat/clipboard";
import { flushPaperNote, readPaperNote } from "./paper-note-state";
import {
  defaultExportParts,
  exportCounts,
  exportParts,
  notesMarkdown,
  type ExportPart,
} from "./notes-export";
import { downloadBlob, downloadText, fileTitle } from "./download";
import { exportAnnotatedPDFWithToast } from "./annotated-pdf-export";

type DocumentExportPart = "translation" | ExportPart;
const labels = { translation: "译文", ...exportParts };
const storageKey = "neoread.notes-export";
function savedParts(): DocumentExportPart[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "");
    if (Array.isArray(value))
      return value.filter(
        (part): part is DocumentExportPart =>
          typeof part === "string" && Object.hasOwn(labels, part),
      );
  } catch {
    /* fall back to defaults */
  }
  return ["translation", ...defaultExportParts];
}

export function ExportDocumentDialog({
  document: doc,
  annotations,
  messages,
  link,
  onClose,
}: {
  document: Document;
  annotations: Annotation[];
  messages: Message[];
  link?: (annotation: Annotation) => string;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<DocumentExportPart[]>(savedParts);
  const [paperNote, setPaperNote] = useState<string | null>(null);
  const [translationCount, setTranslationCount] = useState<number | null>(null);
  const [readErrors, setReadErrors] = useState({
    paperNote: "",
    translation: "",
  });
  const [refresh, setRefresh] = useState(0);
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState<"copy" | "download" | "pdf" | null>(null);
  const [error, setError] = useState("");
  const [noteSaveFailed, setNoteSaveFailed] = useState(false);
  const [savedNoteOnly, setSavedNoteOnly] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [doc.id]);
  useEffect(() => {
    let alive = true;
    setPaperNote(null);
    setNoteSaveFailed(false);
    setSavedNoteOnly(false);
    setTranslationCount(null);
    setReadErrors({ paperNote: "", translation: "" });
    void readPaperNote(doc.id).then(
      (body) => alive && setPaperNote(body),
      () =>
        alive &&
        setReadErrors((errors) => ({
          ...errors,
          paperNote: "笔记读取失败",
        })),
    );
    void api.translations(doc.id).then(
      (items) =>
        alive &&
        setTranslationCount(
          items.filter(
            (item) =>
              item.status === "complete" &&
              (item.formulaMarkdown || item.sentences.length),
          ).length,
        ),
      () =>
        alive &&
        setReadErrors((errors) => ({ ...errors, translation: "译文读取失败" })),
    );
    return () => {
      alive = false;
    };
  }, [doc.id, refresh]);
  const data = { annotations, messages, paperNote: paperNote ?? "" };
  const counts = exportCounts(data);
  const visible = (Object.keys(labels) as DocumentExportPart[]).filter(
    (part) => doc.library === "papers" || part !== "info",
  );
  const count = (part: DocumentExportPart): number | null =>
    part === "translation"
      ? translationCount
      : part === "paperNote" && paperNote === null
        ? null
        : counts[part];
  const selected = visible.filter(
    (part) => parts.includes(part) && count(part) !== 0,
  );
  const ready =
    selected.length > 0 && selected.every((part) => count(part) !== null);
  const translation = selected.includes("translation");
  const noteParts = selected.filter(
    (part): part is ExportPart => part !== "translation",
  );
  const kinds: Annotation["kind"][] = [];
  if (selected.includes("highlights")) kinds.push("highlight", "underline");
  if (selected.includes("notes")) kinds.push("note");
  if (selected.includes("questions")) kinds.push("question");
  const toggle = (part: DocumentExportPart, on: boolean) => {
    const next = on ? [...parts, part] : parts.filter((item) => item !== part);
    setParts(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* session only */
    }
  };
  const close = () => {
    if (busy === "pdf") return;
    request.current?.abort();
    onClose();
  };
  const save = async (action: "copy" | "download") => {
    if (!ready || busy || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(action);
    setError("");
    try {
      // The draft can change while this dialog is open. Export the snapshot
      // acknowledged by the same serialized writer used by both editors.
      let currentNote = data.paperNote;
      if (parts.includes("paperNote")) {
        try {
          currentNote = savedNoteOnly
            ? (await api.documentNote(doc.id)).body
            : await flushPaperNote(doc.id);
          setNoteSaveFailed(false);
        } catch (error) {
          setNoteSaveFailed(!savedNoteOnly);
          throw error;
        }
      }
      if (controller.signal.aborted) return;
      const currentParts =
        parts.includes("paperNote") && !noteParts.includes("paperNote")
          ? [...noteParts, "paperNote" as const]
          : noteParts;
      const notes = notesMarkdown(
        doc,
        { ...data, paperNote: currentNote },
        currentParts,
        link,
        {
          includeTitle: !translation,
        },
      );
      const bundle = translation && images && action === "download";
      if (translation) {
        const blob = await api.exportTranslation(
          doc.id,
          bundle ? "zip" : "markdown",
          controller.signal,
          notes.trim(),
        );
        if (controller.signal.aborted) return;
        if (action === "copy") {
          const text = await blob.text();
          if (!controller.signal.aborted)
            await copyText(text, "已复制 Markdown");
        } else {
          downloadBlob(
            blob,
            `${fileTitle(doc.title)}-导出.${bundle ? "zip" : "md"}`,
          );
          onClose();
        }
      } else if (action === "copy") {
        await copyText(notes, "已复制 Markdown");
      } else {
        downloadText(notes, `${fileTitle(doc.title)}-导出.md`, "text/markdown");
        onClose();
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "导出失败，请重试");
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(null);
      }
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>导出</DialogTitle>
          <DialogDescription>
            勾选要导出的内容，保存为 Markdown。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          {visible.map((part) => (
            <label key={part} className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label={labels[part]}
                checked={parts.includes(part) && count(part) !== 0}
                disabled={!!busy || count(part) === 0}
                onCheckedChange={(checked) => toggle(part, !!checked)}
              />
              <span className="flex-1">{labels[part]}</span>
              {part !== "info" && (
                <span className="text-xs text-muted-foreground">
                  {count(part) ?? "…"}
                </span>
              )}
            </label>
          ))}
        </div>
        {translation && (
          <div className="space-y-2 border-t pt-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={images}
                disabled={!!busy}
                onCheckedChange={(checked) => setImages(!!checked)}
              />
              包含译文中的原文图片
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              {images
                ? "下载 ZIP，包含所选内容的 Markdown 和图片文件夹；复制仅包含 Markdown。"
                : "未完成的译文会标记状态，图片位置显示占位说明。"}
            </p>
          </div>
        )}
        {(readErrors.paperNote || readErrors.translation) && (
          <div role="alert" className="text-sm text-destructive">
            {Object.values(readErrors).filter(Boolean).join("，")}
            ，可重试或取消勾选对应内容。
            <Button
              variant="link"
              size="sm"
              disabled={!!busy}
              onClick={() => setRefresh((value) => value + 1)}
            >
              重试读取
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy === "pdf"} onClick={close}>
            取消
          </Button>
          <Button
            variant="outline"
            disabled={!ready || !!busy}
            onClick={() => void save("copy")}
          >
            {busy === "copy" ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Copy />
            )}
            复制
          </Button>
          <Button
            disabled={!ready || !!busy}
            onClick={() => void save("download")}
          >
            {busy === "download" ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Download />
            )}
            {busy === "download" ? "正在导出…" : "导出"}
          </Button>
        </div>
        {noteSaveFailed && parts.includes("paperNote") && (
          <div className="text-xs text-muted-foreground">
            笔记保存失败，可重试导出，或取消勾选论文笔记后导出其他内容。
            <Button
              variant="link"
              size="xs"
              onClick={() => {
                setSavedNoteOnly(true);
                setNoteSaveFailed(false);
                setError("");
              }}
            >
              使用已保存笔记
            </Button>
          </div>
        )}
        {savedNoteOnly && parts.includes("paperNote") && (
          <p className="text-xs text-muted-foreground" role="status">
            将导出服务器已保存的笔记，不包含当前未保存修改。
          </p>
        )}
        {doc.type === "pdf" && (
          <div className="flex items-center gap-3 border-t pt-4">
            <p className="flex-1 text-xs leading-5 text-muted-foreground">
              导出目录、书签及勾选的批注、划线和问答。不包含译文和论文笔记。
            </p>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={async () => {
                setBusy("pdf");
                await exportAnnotatedPDFWithToast(doc, kinds);
                setBusy(null);
              }}
            >
              {busy === "pdf" ? (
                <LoaderCircle className="animate-spin motion-reduce:animate-none" />
              ) : (
                <FileDown />
              )}
              导出 PDF
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
