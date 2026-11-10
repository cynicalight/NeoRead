import { LayoutGrid, List, Trash2, X } from "lucide-react";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Badge } from "@neoread/ui/components/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@neoread/ui/components/select";
import { libraryTags, initialFilters, type LibraryFilters } from "./library";

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>{options[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([value, text]) => (
          <SelectItem key={value} value={value}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function LibraryFilterBar({
  documents,
  filters,
  onChange,
  view,
  onViewChange,
  count,
}: {
  documents: Document[];
  filters: LibraryFilters;
  onChange: (value: LibraryFilters) => void;
  view: "grid" | "list";
  onViewChange: (value: "grid" | "list") => void;
  count: number;
}) {
  const tags = libraryTags(documents);
  const changed =
    filters.format !== "all" ||
    filters.reading !== "all" ||
    filters.tags.length > 0;
  return (
    <div className="library-filter-bar">
      <Choice
        label="文件格式筛选"
        value={filters.format}
        options={{ all: "全部格式", epub: "EPUB", pdf: "PDF" }}
        onChange={(format) => onChange({ ...filters, format })}
      />
      <Choice
        label="阅读状态筛选"
        value={filters.reading}
        options={{
          all: "全部阅读状态",
          unread: "未读",
          reading: "阅读中",
          finished: "已读完",
        }}
        onChange={(reading) => onChange({ ...filters, reading })}
      />
      <Select
        multiple
        value={filters.tags}
        onValueChange={(tags) => onChange({ ...filters, tags })}
      >
        <SelectTrigger aria-label="标签筛选（同时包含所选标签）">
          <SelectValue>
            {filters.tags.length ? `标签 · ${filters.tags.length}` : "全部标签"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {tags.length ? (
            tags.map((tag) => (
              <SelectItem key={tag.toLowerCase()} value={tag.toLowerCase()}>
                {tag}
              </SelectItem>
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">暂无标签</p>
          )}
        </SelectContent>
      </Select>
      <Choice
        label="文档排序"
        value={filters.sort}
        options={{ recent: "最近打开", added: "最近导入", title: "标题排序" }}
        onChange={(sort) => onChange({ ...filters, sort })}
      />
      {changed && (
        <Button
          size="icon-sm"
          variant="destructive-ghost"
          aria-label="清除筛选"
          title="清除筛选"
          onClick={() => onChange({ ...initialFilters, sort: filters.sort })}
        >
          <Trash2 />
        </Button>
      )}
      <span className="text-xs text-muted-foreground" role="status">
        {count} 份文档
      </span>
      <div className="flex gap-1">
        <Button
          size="icon-sm"
          variant={view === "grid" ? "secondary" : "ghost"}
          aria-label="网格视图"
          aria-pressed={view === "grid"}
          onClick={() => onViewChange("grid")}
        >
          <LayoutGrid />
        </Button>
        <Button
          size="icon-sm"
          variant={view === "list" ? "secondary" : "ghost"}
          aria-label="列表视图"
          aria-pressed={view === "list"}
          onClick={() => onViewChange("list")}
        >
          <List />
        </Button>
      </div>
    </div>
  );
}
export function LibraryTagFilters({
  documents,
  filters,
  onChange,
}: {
  documents: Document[];
  filters: LibraryFilters;
  onChange: (value: LibraryFilters) => void;
}) {
  if (!filters.tags.length) return null;
  const tags = libraryTags(documents);
  return (
    <div className="library-tag-filters">
      <span className="text-xs text-muted-foreground">同时包含</span>
      {filters.tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {tags.find((t) => t.toLowerCase() === tag) ?? tag}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`取消筛选 ${tag}`}
            onClick={() =>
              onChange({
                ...filters,
                tags: filters.tags.filter((t) => t !== tag),
              })
            }
          >
            <X />
          </Button>
        </Badge>
      ))}
    </div>
  );
}
