import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Checkbox } from "@neoread/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import { Input } from "@neoread/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import { creatorName, paperByline, paperCreators } from "../papers/format";
import type { Citation, CitationItem } from "./codes";
import type { CiteEngine } from "./engine";
import { citationItemFor } from "./items";
import { RunsText } from "./RunsText";

/** CSL locator labels, in the order Zotero offers them. */
export const locatorLabels: Record<string, string> = {
  page: "页",
  chapter: "章",
  section: "节",
  paragraph: "段",
  figure: "图",
  line: "行",
  volume: "卷",
  issue: "期",
  part: "部分",
  book: "书",
  column: "栏",
  note: "注",
  verse: "诗节",
  "sub verbo": "词条",
};

const RESULTS = 50;

function matches(doc: Document, words: string[]) {
  const text = [
    doc.title,
    doc.metadata.shortTitle,
    doc.metadata.date,
    doc.metadata.venue,
    doc.metadata.doi,
    doc.metadata.arxiv,
    ...paperCreators(doc).map(creatorName),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Library papers, most recently opened first when nothing is typed. */
export function searchPapers(documents: Document[], query: string) {
  const papers = documents.filter(
    (doc) => doc.library === "papers" && !doc.deletedAt,
  );
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length)
    return [...papers]
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .slice(0, RESULTS);
  return papers.filter((doc) => matches(doc, words)).slice(0, RESULTS);
}

export function CitationEditor({
  documents,
  initial,
  engine,
  before,
  after,
  onDone,
}: {
  documents: Document[];
  initial: Citation | null;
  engine: CiteEngine;
  before: Citation[];
  after: Citation[];
  onDone: (citation: Citation | null) => void;
}) {
  const [items, setItems] = useState<CitationItem[]>(
    () => initial?.citationItems.map((item) => ({ ...item })) || [],
  );
  const [unsorted, setUnsorted] = useState(!!initial?.properties.unsorted);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () =>
      searchPapers(documents, query).filter(
        (doc) => !items.some((item) => item.id === doc.id),
      ),
    [documents, query, items],
  );
  const citation: Citation = {
    citationID: initial?.citationID || "preview",
    properties: { noteIndex: 0, ...(unsorted ? { unsorted: true } : {}) },
    citationItems: items,
  };
  const preview = useMemo(() => {
    if (!items.length) return null;
    try {
      return engine.preview(citation, before, after);
    } catch (e) {
      return [{ text: `无法预览：${(e as Error).message}` }];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, items, unsorted, before, after]);

  const add = (doc: Document) => {
    setItems((list) => [...list, citationItemFor(doc)]);
    setQuery("");
    setActive(0);
    search.current?.focus();
  };
  const change = (index: number, patch: Partial<CitationItem>) =>
    setItems((list) =>
      list.map((item, i) => {
        if (i !== index) return item;
        const next: CitationItem = { ...item, ...patch };
        for (const key of ["locator", "prefix", "suffix"] as const)
          if (!next[key]) delete next[key];
        if (!next["suppress-author"]) delete next["suppress-author"];
        return next;
      }),
    );
  const move = (from: number, to: number) =>
    setItems((list) => {
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  const submit = () => {
    if (items.length) onDone(citation);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onDone(null)}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑引注" : "添加引注"}</DialogTitle>
          <DialogDescription className="sr-only">
            从论文库选择要引用的论文
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={search}
            autoFocus
            className="pl-8"
            placeholder="按标题、作者、年份搜索论文库"
            aria-label="搜索论文"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (query.trim() && results[active]) add(results[active]);
                else submit();
              }
            }}
          />
        </div>
        <div
          role="listbox"
          aria-label="论文"
          className="max-h-56 overflow-y-auto rounded-md border"
        >
          {results.length ? (
            results.map((doc, i) => (
              <button
                key={doc.id}
                type="button"
                role="option"
                aria-selected={i === active}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                onMouseEnter={() => setActive(i)}
                onClick={() => add(doc)}
              >
                <span className="block truncate">{doc.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {paperByline(doc)}
                </span>
              </button>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query.trim() ? "没有匹配的论文" : "论文库中还没有论文"}
            </p>
          )}
        </div>
        {items.length > 0 && (
          <ol className="flex flex-col gap-2" aria-label="已选论文">
            {items.map((item, i) => {
              const title = String(item.itemData.title || item.id);
              return (
                <li key={item.id} className="rounded-md border p-2">
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {title}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`上移 ${title}`}
                      disabled={i === 0}
                      onClick={() => {
                        move(i, i - 1);
                        setUnsorted(true);
                      }}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`下移 ${title}`}
                      disabled={i === items.length - 1}
                      onClick={() => {
                        move(i, i + 1);
                        setUnsorted(true);
                      }}
                    >
                      <ChevronDown />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`移除 ${title}`}
                      onClick={() =>
                        setItems((list) => list.filter((_, j) => j !== i))
                      }
                    >
                      <X />
                    </Button>
                  </div>
                  <div className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 sm:grid-cols-[6.5rem_6rem_minmax(0,1fr)_minmax(0,1fr)]">
                    <Select
                      value={item.label || "page"}
                      onValueChange={(value) =>
                        value && change(i, { label: value as string })
                      }
                    >
                      <SelectTrigger size="sm" aria-label={`定位类型 ${title}`}>
                        <SelectValue>
                          {locatorLabels[item.label || "page"]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(locatorLabels).map(([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="h-8"
                      aria-label={`定位 ${title}`}
                      placeholder="如 12-15"
                      value={item.locator || ""}
                      onChange={(e) =>
                        change(i, {
                          locator: e.target.value,
                          label: item.label || "page",
                        })
                      }
                    />
                    <Input
                      className="h-8"
                      aria-label={`前缀 ${title}`}
                      placeholder="前缀"
                      value={item.prefix || ""}
                      onChange={(e) => change(i, { prefix: e.target.value })}
                    />
                    <Input
                      className="h-8"
                      aria-label={`后缀 ${title}`}
                      placeholder="后缀"
                      value={item.suffix || ""}
                      onChange={(e) => change(i, { suffix: e.target.value })}
                    />
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={!!item["suppress-author"]}
                      onCheckedChange={(checked) =>
                        change(i, { "suppress-author": !!checked })
                      }
                    />
                    省略作者
                  </label>
                </li>
              );
            })}
          </ol>
        )}
        {items.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={unsorted}
              onCheckedChange={(checked) => setUnsorted(!!checked)}
            />
            保持所选顺序
          </label>
        )}
        {preview && (
          <p
            className="rounded-md bg-muted px-3 py-2 text-sm break-words"
            aria-label="预览"
          >
            <RunsText runs={preview} />
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)}>
            取消
          </Button>
          <Button disabled={!items.length} onClick={submit}>
            {initial ? "更新" : "插入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
