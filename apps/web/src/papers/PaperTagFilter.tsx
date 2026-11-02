import {
  cloneElement,
  useRef,
  useState,
  type ReactElement,
  type ComponentProps,
} from "react";
import type { Document, Processing } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@neoread/ui/components/toggle-group";
import { matchTagBoard } from "../library";
import { filterPapers, paperTags } from "./model";
import { useReaderStore } from "../store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import { PaperTagCleanup } from "./PaperTagCleanup";
import { usePaperUI } from "./state";

interface Props {
  documents: Document[];
  jobs: Map<string, Processing>;
}

/** Temporary conditions opened from the table tag column. */
function PaperTagFilter({ documents, jobs }: Props) {
  const { tagFilter, setTagFilter, view, query: textQuery } = usePaperUI();
  const prefs = useReaderStore((s) => s.libraryPreferences.papers) || {};
  const scope = filterPapers(documents, view, textQuery, "title", jobs, {
    subcategories: prefs.subcategoryItems !== false,
    smart: prefs.smartCategories,
    notDuplicates: prefs.notDuplicates,
  });
  const selected = new Set(tagFilter.tags.map((tag) => tag.toLowerCase()));
  const options = paperTags([...scope, { tags: tagFilter.tags }]);
  const counted =
    tagFilter.match === "all" ? matchTagBoard(scope, tagFilter) : scope;
  const counts = new Map<string, number>();
  for (const doc of counted)
    for (const tag of new Set(doc.tags.map((tag) => tag.toLowerCase())))
      counts.set(tag, (counts.get(tag) || 0) + 1);
  return (
    <section className="paper-tag-filter" aria-label="标签筛选">
      <div className="paper-tag-match" role="group" aria-label="标签匹配方式">
        {(
          [
            ["all", "全部 AND"],
            ["any", "任一 OR"],
          ] as const
        ).map(([match, label]) => (
          <Button
            key={match}
            variant="ghost"
            size="xs"
            aria-pressed={tagFilter.match === match}
            onClick={() => setTagFilter({ ...tagFilter, match })}
          >
            {label}
          </Button>
        ))}
      </div>
      <ToggleGroup
        multiple
        size="sm"
        variant="outline"
        className="paper-tag-options flex-wrap justify-start"
        aria-label="可选标签"
        value={[...selected]}
        onValueChange={(value: string[]) =>
          setTagFilter({
            ...tagFilter,
            tags: value.map((key) =>
              options.find((tag) => tag.toLowerCase() === key)!,
            ),
          })
        }
      >
        {options.map((tag) => {
          const key = tag.toLowerCase();
          const active = selected.has(key);
          const count = counts.get(key) || 0;
          return (
            <ToggleGroupItem
              key={key}
              value={key}
              className="paper-tag-option max-w-full px-2 text-xs aria-pressed:border-emerald-300 aria-pressed:bg-emerald-100 aria-pressed:text-emerald-900 dark:aria-pressed:border-emerald-500/40 dark:aria-pressed:bg-emerald-500/20 dark:aria-pressed:text-emerald-200"
              aria-label={`筛选标签 ${tag}`}
              disabled={!active && !count}
              title={tag}
            >
              <span className="min-w-0 truncate">#{tag}</span>
              <span
                className="tabular-nums text-muted-foreground"
                title={
                  tagFilter.match === "all"
                    ? "当前结果篇数"
                    : "当前分类与搜索中的篇数"
                }
              >
                {count}
              </span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {!options.length && (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          当前范围暂无标签
        </p>
      )}
    </section>
  );
}

export function PaperTagFilterButton({
  documents,
  jobs,
  trigger,
}: Props & {
  trigger?: ReactElement<ComponentProps<typeof Button>>;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const column = useRef<HTMLButtonElement>(null);
  const count = usePaperUI((s) => s.tagFilter.tags.length);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={column}
          render={
            trigger ? (
              cloneElement(trigger, {
                "aria-label": "按标签筛选",
                variant: count ? "secondary" : "ghost",
              })
            ) : (
              <Button
                variant={count ? "secondary" : "ghost"}
                size="xs"
                className="max-w-full min-w-0 px-1.5"
                aria-label="按标签筛选"
                title={count ? `筛选标签 · 已选 ${count} 个` : "筛选标签"}
              />
            )
          }
        >
          <span className="truncate">标签</span>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-64"
          aria-label="标签筛选条件"
          finalFocus={managing ? false : undefined}
        >
          <PaperTagFilter documents={documents} jobs={jobs} />
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setOpen(false);
              setManaging(true);
            }}
          >
            管理论文标签
          </Button>
        </PopoverContent>
      </Popover>
      <PaperTagCleanup
        documents={documents}
        open={managing}
        onClose={() => setManaging(false)}
        finalFocus={column}
      />
    </>
  );
}
