import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  LayoutGrid,
  List,
  Pencil,
  Save,
  Tags,
  Trash2,
} from "lucide-react";
import type { Document, Processing, TagBoard } from "@neoread/core";
import { api } from "@neoread/api";
import { toast } from "sonner";
import { Button } from "@neoread/ui/components/button";
import { Badge } from "@neoread/ui/components/badge";
import { Input } from "@neoread/ui/components/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@neoread/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@neoread/ui/components/context-menu";
import { LibraryDocuments } from "./LibraryDocuments";
import {
  filterDocuments,
  initialFilters,
  libraryTags,
  matchTagBoard,
} from "./library";

export function TagBoards({
  documents,
  query,
  jobs,
  processingError,
  openDocument,
  favorite,
  onSettings,
  onOverview,
  onUsage,
  detailId,
  onDetail,
}: {
  documents: Document[];
  query: string;
  jobs: Processing[];
  processingError: string;
  openDocument: (doc: Document) => void;
  favorite: (doc: Document) => void;
  onSettings: () => void;
  onOverview: (doc: Document) => void;
  onUsage: (doc: Document) => void;
  detailId?: string | null;
  onDetail?: (id: string | null) => void;
}) {
  const [boards, setBoards] = useState<TagBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [match, setMatch] = useState<TagBoard["match"]>("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [editor, setEditor] = useState<{
    id?: string;
    name: string;
    tags: string[];
    match: TagBoard["match"];
  } | null>(null);
  const [removing, setRemoving] = useState<TagBoard | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const load = async () => {
    const serial = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const saved = await api.tagBoards();
      if (mounted.current && serial === revision.current) setBoards(saved);
    } catch (e) {
      if (mounted.current && serial === revision.current)
        setError((e as Error).message);
    } finally {
      if (mounted.current && serial === revision.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      ++revision.current;
    };
  }, []);
  const active = boards.find((b) => b.id === activeId);
  const changed =
    active &&
    (active.match !== match ||
      JSON.stringify(active.tags.map((t) => t.toLowerCase()).sort()) !==
        JSON.stringify([...tags].sort()));
  const options = libraryTags(documents);
  for (const tag of [...tags, ...(editor?.tags ?? [])])
    if (!options.some((t) => t.toLowerCase() === tag.toLowerCase()))
      options.push(tag);
  const filtered = filterDocuments(
    matchTagBoard(documents, { tags, match }),
    "all",
    query,
    initialFilters,
  );
  const choose = (board: TagBoard) => {
    setActiveId(board.id);
    setTags(board.tags.map((t) => t.toLowerCase()));
    setMatch(board.match);
  };
  const reset = () => {
    setActiveId(null);
    setTags([]);
    setMatch("all");
  };
  const save = async () => {
    if (!editor || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const body = {
        name: editor.name.trim(),
        tags: editor.tags,
        match: editor.match,
      };
      const board = editor.id
        ? await api.updateTagBoard(editor.id, body)
        : await api.createTagBoard(body);
      if (!mounted.current) return;
      ++revision.current;
      setBoards((current) =>
        editor.id
          ? current.map((b) => (b.id === board.id ? board : b))
          : [...current, board],
      );
      choose(board);
      setEditor(null);
      toast.success("看板已保存");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await api.removeTagBoard(removing.id);
      if (!mounted.current) return;
      ++revision.current;
      setBoards((current) => current.filter((b) => b.id !== removing.id));
      if (activeId === removing.id) reset();
      setRemoving(null);
      toast.success("看板已删除");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const tagSelect = (value: string[], onChange: (tags: string[]) => void) => (
    <Select multiple value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="选择看板标签">
        <SelectValue>
          {value.length ? `已选 ${value.length} 个标签` : "选择标签"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.length ? (
          options.map((tag) => (
            <SelectItem key={tag.toLowerCase()} value={tag.toLowerCase()}>
              {tag}
            </SelectItem>
          ))
        ) : (
          <p className="p-3 text-sm text-muted-foreground">
            暂无标签，请先在文档信息中添加。
          </p>
        )}
      </SelectContent>
    </Select>
  );
  const matchSelect = (
    value: TagBoard["match"],
    onChange: (value: TagBoard["match"]) => void,
  ) => (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as TagBoard["match"]);
      }}
    >
      <SelectTrigger aria-label="标签匹配方式">
        <SelectValue>
          {value === "all" ? "包含全部标签" : "包含任一标签"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">包含全部标签</SelectItem>
        <SelectItem value="any">包含任一标签</SelectItem>
      </SelectContent>
    </Select>
  );
  return (
    <div className="tag-page">
      {error && (
        <div className="flex items-center gap-3 text-sm" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重新加载看板
          </Button>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          正在加载看板…
        </p>
      ) : (
        !active &&
        !error && (
          <section aria-label="已保存的看板">
            <h2 className="text-base font-medium mb-4">已保存的看板</h2>
            {boards.length ? (
              <div className="tag-board-grid">
                {boards.map((board) => {
                  const matches = matchTagBoard(documents, board);
                  return (
                    <ContextMenu key={board.id}>
                      <ContextMenuTrigger
                        render={<article />}
                        className="tag-board-card"
                        onClick={(event) => {
                          if (
                            !(event.target as Element).closest(
                              ".tag-board-actions button",
                            )
                          )
                            choose(board);
                        }}
                      >
                        <div className="tag-board-card-header">
                          <Button
                            variant="ghost"
                            className="tag-board-title"
                            title={board.name}
                          >
                            <Tags />
                            <span>{board.name}</span>
                          </Button>
                          <div className="tag-board-actions">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`编辑看板 ${board.name}`}
                              onClick={() =>
                                setEditor({
                                  ...board,
                                  tags: board.tags.map((t) => t.toLowerCase()),
                                })
                              }
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="destructive-ghost"
                              size="icon-xs"
                              aria-label={`删除看板 ${board.name}`}
                              onClick={() => setRemoving(board)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                        <div className="document-badges">
                          {board.tags.map((tag) => (
                            <Badge key={tag.toLowerCase()} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {board.match === "all"
                            ? "包含全部标签"
                            : "包含任一标签"}{" "}
                          · {matches.length} 份文档
                        </p>
                        <ul className="tag-board-preview">
                          {matches.slice(0, 3).map((d) => (
                            <li key={d.id} title={d.title}>
                              {d.title}
                            </li>
                          ))}
                          {!matches.length && <li>暂无匹配文档</li>}
                        </ul>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onClick={() =>
                            setEditor({
                              ...board,
                              tags: board.tags.map((t) => t.toLowerCase()),
                            })
                          }
                        >
                          <Pencil />
                          编辑看板
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onClick={() => setRemoving(board)}
                        >
                          <Trash2 />
                          删除看板
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无看板。选择下方标签组合后保存。
              </p>
            )}
          </section>
        )
      )}
      <section aria-label={active ? `看板 ${active.name}` : "标签筛选"}>
        <div className="tag-board-heading">
          {active && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="返回全部看板"
              onClick={reset}
            >
              <ArrowLeft />
            </Button>
          )}
          <h2
            className="min-w-0 truncate text-base font-medium"
            title={active?.name}
          >
            {active?.name ?? "标签筛选"}
          </h2>
          {active && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditor({ ...active, tags, match })}
              >
                <Pencil />
                {changed ? "保存更改" : "编辑看板"}
              </Button>
              <Button
                variant="destructive-ghost"
                size="icon-sm"
                aria-label="删除当前看板"
                onClick={() => setRemoving(active)}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
        <div className="tag-board-filters">
          {tagSelect(tags, setTags)}
          {matchSelect(match, setMatch)}
          <Button
            variant="outline"
            size="sm"
            disabled={!tags.length || loading || !!error}
            onClick={() => setEditor({ name: "", tags, match })}
          >
            <Save />
            保存为看板
          </Button>
          {(tags.length > 0 || active) && (
            <Button
              variant="destructive-ghost"
              size="icon-sm"
              aria-label="清除筛选"
              title="清除筛选"
              onClick={reset}
            >
              <Trash2 />
            </Button>
          )}
          <span className="text-xs text-muted-foreground" role="status">
            {filtered.length} 份文档
          </span>
          <div className="ml-auto flex gap-1">
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="网格视图"
              onClick={() => setView("grid")}
            >
              <LayoutGrid />
            </Button>
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="列表视图"
              onClick={() => setView("list")}
            >
              <List />
            </Button>
          </div>
        </div>
        {!!tags.length && (
          <div className="document-badges my-3">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {options.find((t) => t.toLowerCase() === tag) ?? tag}
              </Badge>
            ))}
          </div>
        )}
        {!tags.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            选择标签查看匹配文档
          </p>
        ) : filtered.length ? (
          <LibraryDocuments
            key={JSON.stringify([activeId, tags, match, query])}
            documents={filtered}
            libraryView={view}
            jobs={jobs}
            processingError={processingError}
            openDocument={openDocument}
            favorite={favorite}
            onSettings={onSettings}
            onOverview={onOverview}
            onUsage={onUsage}
            activeId={detailId}
            onActivate={onDetail}
          />
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            没有符合当前标签组合的文档
          </p>
        )}
      </section>
      <Dialog
        open={!!editor}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.id ? "编辑标签看板" : "保存标签看板"}
            </DialogTitle>
            <DialogDescription>
              保存名称和标签组合，文档列表会随标签变化自动更新。
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <fieldset disabled={busy} className="space-y-4 min-w-0">
              <div className="space-y-2">
                <label htmlFor="board-name" className="text-sm font-medium">
                  看板名称
                </label>
                <Input
                  id="board-name"
                  autoFocus
                  value={editor.name}
                  maxLength={80}
                  placeholder="例如：Web 安全"
                  onChange={(e) =>
                    setEditor({ ...editor, name: e.target.value })
                  }
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {tagSelect(editor.tags, (tags) =>
                  setEditor({ ...editor, tags }),
                )}
                {matchSelect(editor.match, (match) =>
                  setEditor({ ...editor, match }),
                )}
              </div>
              <div className="document-badges">
                {editor.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                匹配 {matchTagBoard(documents, editor).length} 份文档
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditor(null)}>
                  取消
                </Button>
                <Button
                  disabled={
                    busy ||
                    !editor.name.trim() ||
                    !editor.tags.length ||
                    editor.tags.length > 30
                  }
                  onClick={() => void save()}
                >
                  {busy ? "保存中…" : "保存"}
                </Button>
              </div>
            </fieldset>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除看板“{removing?.name}”？</DialogTitle>
            <DialogDescription>
              仅删除此标签组合，文档和标签会保留。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "删除中…" : "删除看板"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
