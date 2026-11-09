import { useState } from "react";
import { FileText, Plus, X } from "lucide-react";
import type { Document } from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import { toast } from "sonner";
import { refreshLibrary, useReaderStore } from "../store";
import { paperYear, shortTitle } from "./format";
import { searchText } from "./model";
import { usePaperUI } from "./state";

/** Papers matching every search term, excluding `doc` and its links. */
export function relatedCandidates(
  doc: Document,
  docs: Document[],
  query: string,
  limit = 8,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return docs
    .filter(
      (d) =>
        d.library === "papers" &&
        d.id !== doc.id &&
        !doc.related.includes(d.id) &&
        terms.every((term) => searchText(d).includes(term)),
    )
    .slice(0, limit);
}

async function change(work: Promise<unknown>) {
  try {
    await work;
  } catch (e) {
    toast.error((e as Error).message);
  }
  await refreshLibrary().catch(() => {});
}

/** Papers linked to this one in both directions, like Zotero's "Related". */
export function RelatedPapers({ doc }: { doc: Document }) {
  const all = useReaderStore((s) => s.documents);
  const select = usePaperUI((s) => s.select);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const byId = new Map(all.map((d) => [d.id, d]));
  // Trashed papers keep their links but are not listed.
  const related = doc.related
    .map((id) => byId.get(id))
    .filter((d): d is Document => !!d);
  const candidates = relatedCandidates(doc, all, query);
  return (
    <section className="paper-related">
      <div className="flex items-center justify-between">
        <h3>相关论文</h3>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
        >
          <PopoverTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="关联论文"
                title="关联论文"
              />
            }
          >
            <Plus />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 gap-1 p-2">
            <Input
              autoFocus
              aria-label="搜索要关联的论文"
              placeholder="标题、作者、DOI…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {candidates.map((d) => (
              <Button
                key={d.id}
                variant="ghost"
                size="sm"
                className="paper-related-item"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  void change(api.relateDocuments(doc.id, d.id));
                }}
              >
                <span className="truncate">{d.title}</span>
              </Button>
            ))}
            {query.trim() && !candidates.length && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                没有可关联的论文
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {related.map((d) => (
        <div key={d.id} className="paper-related-row">
          <Button
            variant="ghost"
            size="sm"
            className="paper-related-item"
            title={d.title}
            onClick={() =>
              d.library === "papers"
                ? select(d.id)
                : toast.info("这篇文档在图书库中")
            }
          >
            <FileText />
            <span className="truncate">{shortTitle(d)}</span>
            {paperYear(d.metadata) && (
              <span className="text-muted-foreground">
                {paperYear(d.metadata)}
              </span>
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`取消关联 ${d.title}`}
            onClick={() => void change(api.unrelateDocuments(doc.id, d.id))}
          >
            <X />
          </Button>
        </div>
      ))}
    </section>
  );
}
