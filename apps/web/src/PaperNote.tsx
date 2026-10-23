import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, ListPlus, Maximize2 } from "lucide-react";
import { neoreadLink, type Annotation } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Textarea } from "@neoread/ui/components/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@neoread/ui/components/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@neoread/ui/components/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@neoread/ui/components/tabs";
import { annotationDigest } from "./notes-export";
import { getPaperNote } from "./paper-note-state";
import { PaperNoteMarkdown } from "./PaperNoteMarkdown";

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
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 767px)").matches ?? false,
  );
  const expandButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const previewBody = useDeferredValue(body);
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
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 767px)");
    if (!media) return;
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
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
  const editPane = (
    <Textarea
      ref={editor}
      aria-label="编辑论文笔记"
      placeholder="使用 Markdown 记录要点、疑问和启发…"
      disabled={unavailable}
      value={body}
      onChange={(event) => note.edit(event.target.value)}
      onBlur={save}
      className="paper-note-editor-input"
    />
  );
  const previewPane = (
    <div className="paper-note-preview" aria-label="论文笔记预览">
      {previewBody ? (
        <PaperNoteMarkdown body={previewBody} />
      ) : (
        <p className="text-muted-foreground">暂无笔记</p>
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
        initialFocus={editor}
        finalFocus={expandButton}
        onKeyDown={(event) => {
          // Keep native editing shortcuts, without triggering App commands.
          if (event.metaKey || event.ctrlKey) event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>论文笔记</DialogTitle>
          <DialogDescription>Markdown 编辑与预览</DialogDescription>
        </DialogHeader>
        {narrow ? (
          <Tabs defaultValue="edit" className="paper-note-editor-tabs">
            <TabsList aria-label="笔记视图">
              <TabsTrigger value="edit">编辑</TabsTrigger>
              <TabsTrigger value="preview">预览</TabsTrigger>
            </TabsList>
            <TabsContent value="edit" keepMounted>
              {editPane}
            </TabsContent>
            <TabsContent value="preview" keepMounted>
              {previewPane}
            </TabsContent>
          </Tabs>
        ) : (
          <div className="paper-note-panes">
            <section aria-label="编辑">{editPane}</section>
            <section aria-label="预览">{previewPane}</section>
          </div>
        )}
        {feedback}
      </DialogContent>
    </Dialog>
  );
}
