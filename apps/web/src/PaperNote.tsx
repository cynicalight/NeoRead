import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, ListPlus, Maximize2 } from "lucide-react";
import { readerLink, type Annotation } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Textarea } from "@reader/ui/components/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@reader/ui/components/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@reader/ui/components/dialog";
import { annotationDigest } from "./notes-export";
import { getPaperNote } from "./paper-note-state";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

const statusLabels = {
  loading: "读取中…",
  "load-error": "读取失败",
  dirty: "待保存",
  saving: "保存中…",
  saved: "已保存",
  "save-error": "保存失败",
};

export function PaperNote({
  documentId,
  annotations,
}: {
  documentId: string;
  annotations: Annotation[];
}) {
  const note = useMemo(() => getPaperNote(documentId), [documentId]);
  const { body, status, error } = useSyncExternalStore(
    note.subscribe,
    note.getSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const unavailable = status === "loading" || status === "load-error";
  useEffect(() => {
    let active = true;
    void note
      .load()
      .then(() => {
        if (active) setOpen(!!note.getSnapshot().body);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [note]);
  const save = () => void note.flush().catch(() => {});
  const digest = unavailable
    ? ""
    : annotationDigest(annotations, body, (a) =>
        readerLink({ id: documentId, annotation: a.id }),
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
  return (
    <Dialog
      open={expanded}
      onOpenChange={(value) => {
        setExpanded(value);
        if (value) setOpen(true);
        else save();
      }}
    >
      <Collapsible open={open} onOpenChange={setOpen} className="paper-note">
        <div className="flex items-center gap-1">
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="paper-note-toggle" />
            }
          >
            <ChevronDown data-open={open} />
            论文笔记
          </CollapsibleTrigger>
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
        </div>
        {!expanded && feedback}
        <CollapsibleContent>
          <Textarea
            aria-label="论文笔记"
            placeholder="记下整篇的要点、疑问和启发…"
            disabled={unavailable}
            value={body}
            onChange={(event) => note.edit(event.target.value)}
            onBlur={save}
            className="paper-note-input"
          />
          <Button
            size="xs"
            variant="ghost"
            className="mt-1 text-muted-foreground"
            disabled={unavailable || !digest}
            title={digest ? undefined : "所有批注都已摘录"}
            onClick={() => {
              note.edit(body ? `${body}\n\n${digest}\n` : `${digest}\n`);
              save();
            }}
          >
            <ListPlus />
            摘录批注
          </Button>
        </CollapsibleContent>
      </Collapsible>
      <DialogContent
        className="paper-note-dialog"
        finalFocus={expandButton}
        onKeyDown={(event) => {
          // Keep native editing shortcuts, without triggering App commands.
          if (event.metaKey || event.ctrlKey) event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>论文笔记</DialogTitle>
          <DialogDescription>
            Markdown 笔记 · 公式可在源码中编辑
          </DialogDescription>
        </DialogHeader>
        {expanded && (
          <PaperNoteRichEditor
            key={documentId}
            body={body}
            disabled={unavailable}
            onChange={note.edit}
            onBlur={save}
          />
        )}
        {feedback}
      </DialogContent>
    </Dialog>
  );
}
