import { AnnotationQuote } from "./AnnotationQuote";
import { useEffect, useRef, useState } from "react";
import { registerTabCloseGuard } from "./document-tab-guards";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Link,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
} from "lucide-react";
import {
  neoreadLink,
  locationLabel,
  type Annotation,
  type Document,
  type Message,
} from "@neoread/core";
import { api } from "@neoread/api";
import { Badge } from "@neoread/ui/components/badge";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Textarea } from "@neoread/ui/components/textarea";
import { ScrollArea } from "@neoread/ui/components/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@neoread/ui/components/collapsible";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@neoread/ui/components/toggle-group";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import { toast } from "sonner";
import { annotationLabels } from "./AnnotationToolbar";
import { copyText } from "./chat/clipboard";
import { colorLabel, documentOrder, highlightPalette } from "./annotations";
import { useReaderStore } from "./store";
import { PaperNote } from "./PaperNote";

export { documentOrder };

export type NotesFilter =
  "all" | "highlight" | "note" | "question" | "bookmark";
const filterLabels: Record<NotesFilter, string> = {
  all: "全部",
  highlight: "划线",
  note: "批注",
  question: "问题",
  bookmark: "书签",
};

export const matchesFilter = (a: Annotation, filter: NotesFilter) =>
  filter === "all" ||
  (filter === "highlight"
    ? a.kind === "highlight" || a.kind === "underline"
    : a.kind === filter);

/** Colors used by more than one kind of mark are worth filtering by. */
export function annotationFacets(annotations: Annotation[]) {
  const colors = new Map<string, string>();
  for (const a of annotations) {
    if (a.kind !== "bookmark" && a.color)
      colors.set(a.color.toLowerCase(), a.color);
  }
  return {
    colors: colors.size > 1 ? [...colors.values()] : [],
  };
}

export const isOpenQuestion = (a: Annotation) =>
  a.kind === "question" && !a.answerId && !a.resolved;

const plain = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`~$]+/g, "")
    .replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

function NoteCard({
  annotation: a,
  answer,
  deleting,
  answering,
  onGo,
  onDelete,
  onSave,
  onAnswer,
  onResolve,
  onShowAnswer,
}: {
  annotation: Annotation;
  answer?: Message;
  deleting: boolean;
  answering: boolean;
  onGo: () => void;
  onDelete: () => void;
  onSave: (note: string) => Promise<boolean>;
  onAnswer: () => void;
  onResolve: (resolved: boolean) => void;
  onShowAnswer: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.note);
  const [saving, setSaving] = useState(false);
  const closeState = useRef({ editing, saving, changed: false });
  closeState.current = { editing, saving, changed: draft !== a.note };
  useEffect(
    () =>
      registerTabCloseGuard(a.documentId, () =>
        closeState.current.saving
          ? { blocked: true, message: "批注正在保存，请保存完成后再关闭。" }
          : closeState.current.editing && closeState.current.changed
            ? { message: "正在编辑的批注尚未保存，关闭后会丢失。" }
            : null,
      ),
    [a.documentId],
  );
  const question = a.kind === "question";
  return (
    <article className="note-card" data-kind={a.kind}>
      <div>
        <Badge variant="outline">
          {annotationLabels[a.kind]}
          {question &&
            (a.answerId ? " · 已回答" : a.resolved ? " · 已解决" : "")}
        </Badge>
        <span className="flex items-center">
          {a.kind !== "bookmark" && !editing && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={question ? "编辑问题" : "编辑批注"}
              onClick={() => {
                setDraft(a.note);
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="复制链接"
            title="复制链接，可在笔记软件中点开回到这里"
            onClick={() =>
              void copyText(
                neoreadLink({ id: a.documentId, annotation: a.id }),
                "已复制链接",
              )
            }
          >
            <Link />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="删除记录"
            disabled={deleting}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </span>
      </div>
      <Button variant="ghost" className="note-quote" onClick={onGo}>
        <AnnotationQuote
          quote={a.quote || locationLabel(a.location)}
          location={a.location}
        />
      </Button>
      {editing ? (
        <div className="note-editor">
          <Textarea
            autoFocus
            aria-label={question ? "问题" : "批注"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="grid grid-cols-2 gap-1">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              size="xs"
              disabled={saving || (question && !draft.trim())}
              onClick={() => {
                setSaving(true);
                void onSave(draft)
                  .then((ok) => ok && setEditing(false))
                  .finally(() => setSaving(false));
              }}
            >
              <Check />
              保存
            </Button>
          </div>
        </div>
      ) : (
        a.note && <p>{a.note}</p>
      )}
      {question && !editing && (
        <div className="note-question">
          {a.answerId ? (
            <Button
              variant="ghost"
              className="note-answer"
              onClick={() => onShowAnswer(a.answerId!)}
            >
              <Sparkles className="size-3" />
              <span>
                {answer ? plain(answer.content).slice(0, 180) : "查看回答"}
              </span>
            </Button>
          ) : a.resolved ? (
            <Button size="xs" variant="ghost" onClick={() => onResolve(false)}>
              重新打开
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant="secondary"
                disabled={answering}
                onClick={onAnswer}
              >
                {answering ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Sparkles />
                )}
                让 AI 回答
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onResolve(true)}>
                标为已解决
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function NotesPanel({
  document: doc,
  annotations,
  messages,
  deleting,
  answering,
  onGo,
  onDelete,
  onSave,
  onAnswer,
  onResolve,
  onShowAnswer,
  onExport,
}: {
  document: Document;
  annotations: Annotation[];
  messages: Message[];
  deleting: ReadonlySet<string>;
  answering: ReadonlySet<string>;
  onGo: (annotation: Annotation) => void;
  onDelete: (id: string) => void;
  onSave: (
    annotation: Annotation,
    patch: { note: string; tags: string[] },
  ) => Promise<boolean>;
  onAnswer: (annotation: Annotation) => void;
  onResolve: (annotation: Annotation, resolved: boolean) => void;
  onShowAnswer: (id: string) => void;
  onExport: () => void;
}) {
  const [filter, setFilter] = useState<NotesFilter>("all");
  const [openOnly, setOpenOnly] = useState(false);
  const [color, setColor] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(""), [doc.id]);
  const query = search.trim().toLocaleLowerCase();
  const facets = annotationFacets(annotations);
  const palette = highlightPalette(useReaderStore((s) => s.theme));
  // A color that no longer exists stops filtering.
  const activeColor = facets.colors.some(
    (c) => c.toLowerCase() === color.toLowerCase(),
  )
    ? color
    : "";
  const counts = Object.fromEntries(
    (Object.keys(filterLabels) as NotesFilter[]).map((key) => [
      key,
      annotations.filter((a) => matchesFilter(a, key)).length,
    ]),
  ) as Record<NotesFilter, number>;
  const open = annotations.filter(isOpenQuestion).length;
  const visible = annotations
    .filter(
      (a) =>
        matchesFilter(a, filter) &&
        (!openOnly || filter !== "question" || isOpenQuestion(a)) &&
        (!activeColor ||
          (a.kind !== "bookmark" &&
            a.color.toLowerCase() === activeColor.toLowerCase())) &&
        (!query || `${a.quote} ${a.note}`.toLocaleLowerCase().includes(query)),
    )
    .sort(documentOrder);
  const byId = new Map(messages.map((m) => [m.id, m]));
  return (
    <div className="notes-panel">
      <div className="notes-search">
        <Search aria-hidden="true" />
        <Input
          type="search"
          aria-label="搜索批注内容"
          placeholder="搜索批注内容"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="notes-list">
          <PaperNote
            key={doc.id}
            documentId={doc.id}
            annotations={annotations}
          />
          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as NotesFilter)}
          >
            <TabsList aria-label="筛选记录" className="notes-filter">
              {(Object.keys(filterLabels) as NotesFilter[]).map((key) => (
                <TabsTrigger key={key} value={key} className="px-2 text-xs">
                  {filterLabels[key]}
                  {key !== "all" && counts[key] > 0 && (
                    <small className="text-muted-foreground">
                      {counts[key]}
                    </small>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {facets.colors.length > 0 && (
            <div className="notes-facets">
              <ToggleGroup
                aria-label="按颜色筛选"
                size="sm"
                spacing={0}
                value={activeColor ? [activeColor] : []}
                onValueChange={(value: string[]) => setColor(value[0] || "")}
              >
                {facets.colors.map((c) => (
                  <ToggleGroupItem
                    key={c}
                    value={c}
                    aria-label={`只看${colorLabel(c, palette)}`}
                    title={colorLabel(c, palette)}
                    className="size-7 min-w-7 px-0"
                  >
                    <span className="color-dot" style={{ background: c }} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          {filter === "question" && open > 0 && (
            <Button
              size="xs"
              variant={openOnly ? "secondary" : "ghost"}
              aria-pressed={openOnly}
              className="mb-2"
              onClick={() => setOpenOnly(!openOnly)}
            >
              <CircleHelp />
              只看待回答（{open}）
            </Button>
          )}
          {!visible.length && (
            <div className="notes-empty">
              <StickyNote />
              <p>
                {query
                  ? "没有匹配的记录"
                  : annotations.length
                    ? "没有这类记录"
                    : "暂无批注"}
              </p>
              {!annotations.length && (
                <small>选中文字添加高亮、批注或问题。</small>
              )}
            </div>
          )}
          {visible.map((a) => (
            <NoteCard
              key={a.id}
              annotation={a}
              answer={a.answerId ? byId.get(a.answerId) : undefined}
              deleting={deleting.has(a.id)}
              answering={answering.has(a.id)}
              onGo={() => onGo(a)}
              onDelete={() => onDelete(a.id)}
              onSave={(note) => onSave(a, { note, tags: a.tags || [] })}
              onAnswer={() => onAnswer(a)}
              onResolve={(resolved) => onResolve(a, resolved)}
              onShowAnswer={onShowAnswer}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="notes-footer">
        <span>{annotations.length} 条记录</span>

        <Button size="sm" variant="ghost" onClick={onExport}>
          <Download />
          导出
        </Button>
      </div>
    </div>
  );
}
