import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ListPlus, Maximize2 } from "lucide-react";
import { neoreadLink, type Annotation } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@neoread/ui/components/dialog";
import { annotationDigest } from "./notes-export";
import { registerTabCloseGuard } from "./document-tab-guards";
import { getPaperNote } from "./paper-note-state";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

const statusLabels = {
  loading: "读取中…",
  "load-error": "读取失败",
  dirty: "待保存",
  saving: "保存中…",
  saved: "已保存",
};

export function PaperNote({
  documentId,
  annotations,
  active = true,
}: {
  documentId: string;
  annotations: Annotation[];
  active?: boolean;
}) {
  const note = useMemo(() => getPaperNote(documentId), [documentId]);
  const { body, status, error } = useSyncExternalStore(
    note.subscribe,
    note.getSnapshot,
  );
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const unavailable = status === "loading" || status === "load-error";
  useEffect(() => {
    void note.load().catch(() => {});
  }, [note]);
  useEffect(() => {
    if (active) return;
    setExpanded(false);
    if (note.hasPending()) void note.flush().catch(() => {});
  }, [active, note]);
  useEffect(
    () =>
      registerTabCloseGuard(documentId, () =>
        note.getSnapshot().status === "saving"
          ? { blocked: true, message: "论文笔记正在保存，请保存完成后再关闭。" }
          : note.hasPending()
            ? { message: "论文笔记还有未保存的修改，关闭后可能丢失。" }
            : null,
      ),
    [documentId, note],
  );
  const save = () => void note.flush().catch(() => {});
  const digest = unavailable
    ? ""
    : annotationDigest(annotations, body, (a) =>
        neoreadLink({ id: documentId, annotation: a.id }),
      );
  const feedback = (
    <div className="paper-note-status" aria-live="polite">
      {error ? (
        <>
          <span role="alert">
            {statusLabels[status]}：{error}
          </span>
          <Button
            variant="link"
            size="xs"
            onClick={() =>
              void (status === "load-error" ? note.load() : note.flush()).catch(
                () => {},
              )
            }
          >
            重试
          </Button>
        </>
      ) : (
        statusLabels[status]
      )}
    </div>
  );
  const excerpt = (
    <Button
      size="xs"
      variant="ghost"
      disabled={unavailable || !digest}
      title={digest ? undefined : "所有批注都已摘录"}
      onClick={() => {
        note.edit(
          body.trimEnd() ? `${body.trimEnd()}\n\n${digest}\n` : `${digest}\n`,
        );
        save();
      }}
    >
      <ListPlus />
      摘录批注
    </Button>
  );
  return (
    <Dialog
      open={expanded && active}
      onOpenChange={(value) => {
        setExpanded(value);
        if (!value) save();
      }}
    >
      <div className="paper-note">
        {active && !expanded && (
          <PaperNoteRichEditor
            key={documentId}
            body={body}
            disabled={unavailable}
            onChange={note.edit}
            onBlur={save}
            actions={
              <>
                {excerpt}
                <DialogTrigger
                  render={
                    <Button
                      ref={expandButton}
                      variant="ghost"
                      size="icon-xs"
                      aria-label="展开论文笔记"
                      title="展开编辑"
                    />
                  }
                >
                  <Maximize2 />
                </DialogTrigger>
              </>
            }
          />
        )}
        {!expanded && feedback}
      </div>
      <DialogContent className="paper-note-dialog" finalFocus={expandButton}>
        <DialogHeader>
          <DialogTitle>论文笔记</DialogTitle>
          <DialogDescription>
            Markdown 笔记 · 公式可在源码中编辑
          </DialogDescription>
        </DialogHeader>
        {expanded && active && (
          <PaperNoteRichEditor
            key={documentId}
            body={body}
            disabled={unavailable}
            onChange={note.edit}
            onBlur={save}
            actions={excerpt}
          />
        )}
        {feedback}
      </DialogContent>
    </Dialog>
  );
}
