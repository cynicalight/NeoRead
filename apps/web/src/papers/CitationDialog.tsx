import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Download, GripVertical } from "lucide-react";
import { CopyButton } from "../CopyButton";
import type { Document } from "@neoread/core";
import { Badge } from "@neoread/ui/components/badge";
import { Button } from "@neoread/ui/components/button";
import { Textarea } from "@neoread/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import { copyText } from "../chat/clipboard";
import { downloadText } from "../download";
import { useReaderStore } from "../store";
import { savePaperPreferences } from "./actions";
import {
  citationOrders,
  citationStyles,
  formatCitations,
  missingFields,
  orderForCitation,
  type CitationOrder,
  type CitationStyle,
} from "./citation";

const safeName = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 80)
    .trim() || "references";

export function CitationDialog({
  docs,
  title,
  onClose,
  onEdit,
}: {
  docs: Document[];
  title: string;
  onClose: () => void;
  onEdit: (doc: Document) => void;
}) {
  const prefs = useReaderStore((s) => s.libraryPreferences.papers) || {};
  const [style, setStyle] = useState<CitationStyle>(
    prefs.citationStyle || "gb7714",
  );
  const [order, setOrder] = useState<CitationOrder>(
    prefs.citationOrder || "author",
  );
  const [items, setItems] = useState(() =>
    orderForCitation(docs, prefs.citationOrder || "author"),
  );
  const [preview, setPreview] = useState("");
  const [dragging, setDragging] = useState(-1);
  useEffect(() => {
    let alive = true;
    void formatCitations(items, style)
      .then((text) => alive && setPreview(text))
      .catch(
        (e) => alive && setPreview(`无法生成引用：${(e as Error).message}`),
      );
    return () => {
      alive = false;
    };
  }, [items, style]);
  const changeOrder = (next: CitationOrder) => {
    setOrder(next);
    if (next !== "custom") setItems((list) => orderForCitation(list, next));
    void savePaperPreferences((p) => ({ ...p, citationOrder: next }));
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    setItems((list) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setOrder("custom");
  };
  const meta = citationStyles[style];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            导出引用 · {title}（{items.length} 篇）
          </DialogTitle>
          <DialogDescription className="sr-only">
            选择引用格式和顺序，复制或保存为文件
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={style}
            onValueChange={(value) => {
              setStyle(value as CitationStyle);
              void savePaperPreferences((p) => ({
                ...p,
                citationStyle: value as CitationStyle,
              }));
            }}
          >
            <TabsList aria-label="引用格式">
              {(Object.keys(citationStyles) as CitationStyle[]).map((key) => (
                <TabsTrigger key={key} value={key} className="px-2.5">
                  {citationStyles[key].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Select
            value={order}
            onValueChange={(value) =>
              value && changeOrder(value as CitationOrder)
            }
          >
            <SelectTrigger size="sm" aria-label="引用顺序">
              <SelectValue>{citationOrders[order]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(citationOrders) as CitationOrder[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {citationOrders[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ol className="citation-items" aria-label="引用顺序，可拖动调整">
          {items.map((doc, i) => {
            const missing = missingFields(doc, style);
            return (
              <li
                key={doc.id}
                className="citation-item"
                draggable
                data-dragging={dragging === i || undefined}
                onDragStart={(e) => {
                  setDragging(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (dragging >= 0) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  move(dragging, i);
                  setDragging(-1);
                }}
                onDragEnd={() => setDragging(-1)}
              >
                <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={doc.title}>
                  {doc.title}
                </span>
                {missing.length > 0 && (
                  <>
                    <Badge variant="outline">缺{missing.join("、")}</Badge>
                    <Button
                      size="xs"
                      variant="link"
                      onClick={() => onEdit(doc)}
                    >
                      去补
                    </Button>
                  </>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`上移 ${doc.title}`}
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  <ChevronUp />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`下移 ${doc.title}`}
                  disabled={i === items.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <ChevronDown />
                </Button>
              </li>
            );
          })}
        </ol>
        <Textarea
          readOnly
          aria-label="引用预览"
          spellCheck={false}
          className="citation-preview"
          value={preview}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!preview}
            onClick={() =>
              downloadText(
                preview,
                `${safeName(title)}.${meta.extension}`,
                meta.mime,
              )
            }
          >
            <Download />
            保存为文件
          </Button>
          <CopyButton
            size="icon"
            variant="outline"
            disabled={!preview}
            onCopy={() => copyText(preview)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
