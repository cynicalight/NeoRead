import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileText,
  ArrowUpRight,
  Star,
  Pencil,
  Trash2,
  Check,
  ChartColumn,
  ArrowRightLeft,
  FileDown,
} from "lucide-react";
import { exportAnnotatedPDFWithToast } from "./annotated-pdf-export";
import type { Document, LibraryMode, Processing } from "@reader/core";
import { api } from "@reader/api";
import { toast } from "sonner";
import { Button } from "@reader/ui/components/button";
import { Checkbox } from "@reader/ui/components/checkbox";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@reader/ui/components/context-menu";
import { DocumentBadges } from "./DocumentManagement";
import { ProcessingUsageDialog } from "./ProcessingUsage";
import {
  CoverOverview,
  DocumentOverviewDialog,
  useOverviewJobs,
} from "./DocumentOverview";
import { CoverProcessing } from "./ProcessingStatus";
import { toggleDocumentSelection, trashWithUndo } from "./library-actions";

export function LibraryDocuments({
  documents,
  libraryView,
  jobs,
  processingError,
  openDocument,
  openDocuments,
  favorite,
  onEdit,
  onMove,
  onSettings,
  editing,
  onEditingChange,
}: {
  documents: Document[];
  libraryView: "grid" | "list";
  jobs: Processing[];
  processingError: string;
  openDocument: (doc: Document) => void;
  openDocuments?: (docs: Document[]) => void;
  favorite: (doc: Document) => void;
  onEdit: (id: string) => void;
  onMove?: (doc: Document, library: LibraryMode) => void;
  onSettings: () => void;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [overviewDocument, setOverviewDocument] = useState<Document | null>(
    null,
  );
  const overviewJobs = useOverviewJobs();
  const [usageDocument, setUsageDocument] = useState<Document | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState(false);
  const pending = useRef(false);
  const anchor = useRef<string | null>(null);
  const selected = new Set(
    documents.filter((d) => selection.has(d.id)).map((d) => d.id),
  );
  const selecting = editing ?? mode;
  const changeEditing = onEditingChange ?? setMode;
  useEffect(() => {
    if (!selecting) {
      setSelection(new Set());
      anchor.current = null;
    }
  }, [selecting]);
  const all = documents.length > 0 && selected.size === documents.length;
  const toggle = (id: string, range = false) => {
    setSelection(
      toggleDocumentSelection(
        selected,
        documents.map((d) => d.id),
        id,
        range ? anchor.current : null,
      ),
    );
    anchor.current = id;
  };
  const trash = async (ids: string[]) => {
    if (pending.current) return;
    pending.current = true;
    try {
      const result = await trashWithUndo(ids);
      setSelection(
        (current) =>
          new Set([...current].filter((id) => !result.deleted.includes(id))),
      );
      return result;
    } finally {
      pending.current = false;
    }
  };
  const removeSelected = () =>
    void trash([...selected]).then((result) => {
      if (result && !result.failed.length) changeEditing(false);
    });
  return (
    <section
      aria-label="文档列表"
      onKeyDown={(e) => {
        if (
          (e.target as Element).closest(
            'input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]',
          )
        )
          return;
        if (
          selecting &&
          (e.metaKey || e.ctrlKey) &&
          e.key.toLowerCase() === "a"
        ) {
          e.preventDefault();
          setSelection(new Set(documents.map((d) => d.id)));
        }
        if (e.key === "Escape") {
          changeEditing(false);
          setSelection(new Set());
        }
      }}
    >
      {(!onEditingChange || selecting) && (
        <div className="library-selection-bar">
          {!onEditingChange && (
            <Button
              variant={selecting ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={selecting}
              onClick={() => changeEditing(!selecting)}
            >
              {selecting ? <Check /> : <Pencil />}
              {selecting ? "完成" : "编辑"}
            </Button>
          )}
          {selecting && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={all}
                  indeterminate={selected.size > 0 && !all}
                  onCheckedChange={() =>
                    setSelection(
                      all ? new Set() : new Set(documents.map((d) => d.id)),
                    )
                  }
                />
                全选当前结果
              </label>
              <span className="text-sm text-muted-foreground" role="status">
                已选 {selected.size} 份
              </span>
              {openDocuments && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!selected.size}
                  onClick={() =>
                    openDocuments(
                      documents.filter((doc) => selected.has(doc.id)),
                    )
                  }
                >
                  <BookOpen />
                  在标签页中打开
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                className="ml-auto"
                disabled={!selected.size}
                onClick={removeSelected}
              >
                <Trash2 />
                移到回收站
              </Button>
            </>
          )}
        </div>
      )}
      <div className={`book-grid ${libraryView === "list" ? "book-list" : ""}`}>
        {documents.map((doc, i) => (
          <ContextMenu key={doc.id}>
            <ContextMenuTrigger
              render={<article />}
              className="book-card"
              data-selected={selecting && selected.has(doc.id)}
              tabIndex={0}
              aria-label={doc.title}
              onKeyDown={(e) => {
                if (
                  e.target === e.currentTarget &&
                  (e.key === "Enter" || e.key === " ")
                ) {
                  e.preventDefault();
                  if (selecting) toggle(doc.id, e.shiftKey);
                  else openDocument(doc);
                }
              }}
              onClickCapture={(e) => {
                if (
                  selecting &&
                  !(e.target as Element).closest(
                    '[data-document-action], [data-slot="checkbox"]',
                  )
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle(doc.id, e.shiftKey);
                }
              }}
            >
              {selecting && (
                <div className="book-select" data-document-action>
                  <Checkbox
                    checked={selected.has(doc.id)}
                    aria-label={`选择 ${doc.title}`}
                    onCheckedChange={() => toggle(doc.id)}
                  />
                </div>
              )}
              <div className="book-cover-frame">
                <Button
                  variant="ghost"
                  title={doc.title}
                  aria-label={`打开 ${doc.title}`}
                  className={`book-cover cover-${i % 4}`}
                  onClick={() => openDocument(doc)}
                >
                  <div className="cover-top">
                    <span>{doc.type.toUpperCase()}</span>
                    {doc.type === "epub" ? (
                      <BookOpen size={18} />
                    ) : (
                      <FileText size={18} />
                    )}
                  </div>
                  <div className="cover-text">
                    <div className="cover-title">{doc.title}</div>
                    {doc.author && (
                      <div className="cover-author" title={doc.author}>
                        {doc.author}
                      </div>
                    )}
                  </div>
                  <div className="cover-bottom">
                    <ArrowUpRight size={18} />
                  </div>
                  <div className="cover-decoration" />
                </Button>
                {overviewJobs.some(
                  (o) =>
                    o.documentId === doc.id &&
                    (!["complete", "canceled"].includes(o.status) ||
                      !jobs.some(
                        (j) =>
                          j.documentId === doc.id &&
                          (j.incomplete ||
                            j.status === "failed" ||
                            j.status === "waiting"),
                      )),
                ) &&
                !jobs.some(
                  (j) =>
                    j.documentId === doc.id &&
                    (j.status === "running" || j.status === "queued"),
                ) ? (
                  <CoverOverview
                    job={overviewJobs.find((o) => o.documentId === doc.id)!}
                    onOpen={() => setOverviewDocument(doc)}
                  />
                ) : (
                  doc.type === "pdf" &&
                  (jobs.find((job) => job.documentId === doc.id) ? (
                    <CoverProcessing
                      job={jobs.find((job) => job.documentId === doc.id)!}
                      onSettings={onSettings}
                      unavailable={!!processingError}
                    />
                  ) : (
                    <Button
                      data-document-action
                      className="cover-analyze"
                      size="xs"
                      variant="secondary"
                      onClick={() =>
                        void api
                          .process(doc.id)
                          .catch((e) => toast.error(e.message))
                      }
                    >
                      分析文档
                    </Button>
                  ))
                )}
              </div>
              <div className="book-meta">
                <Button
                  title={doc.title}
                  className="book-title"
                  variant="ghost"
                  onClick={() => openDocument(doc)}
                >
                  <span>{doc.title}</span>
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  data-document-action
                  aria-label={doc.favorite ? "取消收藏" : "收藏文档"}
                  onClick={() => void favorite(doc)}
                >
                  <Star
                    className={
                      doc.favorite ? "fill-current text-amber-500" : ""
                    }
                  />
                </Button>
              </div>
              <div className="document-organization">
                <DocumentBadges document={doc} />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`查看 ${doc.title} 的用量统计`}
                  title="用量统计"
                  data-document-action
                  onClick={() => setUsageDocument(doc)}
                >
                  <ChartColumn />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`编辑 ${doc.title} 的信息`}
                  data-document-action
                  title="编辑文档信息"
                  onClick={() => onEdit(doc.id)}
                >
                  <Pencil />
                </Button>
              </div>
              {doc.categorySource !== "manual" &&
                doc.classificationStatus === "failed" && (
                  <p className="classification-status">
                    AI 分类失败 · 可手动修改或重试
                  </p>
                )}
              <div className="book-progress">
                <div
                  style={{
                    width: `${Math.round(doc.percentage * 100)}%`,
                  }}
                />
              </div>
              <p className="book-status">
                {doc.percentage > 0
                  ? `已读 ${Math.round(doc.percentage * 100)}%`
                  : "还未开始阅读"}
                <span>{(doc.size / 1024 / 1024).toFixed(1)} MB</span>
              </p>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => setOverviewDocument(doc)}>
                <BookOpen />
                文档概要
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setUsageDocument(doc)}>
                <ChartColumn />
                用量统计
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onEdit(doc.id)}>
                <Pencil />
                编辑文档信息
              </ContextMenuItem>
              {doc.type === "pdf" && (
                <ContextMenuItem
                  onClick={() => void exportAnnotatedPDFWithToast(doc)}
                >
                  <FileDown />
                  导出带批注的 PDF
                </ContextMenuItem>
              )}
              {onMove && (doc.type === "pdf" || doc.library === "papers") && (
                <ContextMenuItem
                  onClick={() =>
                    onMove(doc, doc.library === "papers" ? "books" : "papers")
                  }
                >
                  <ArrowRightLeft />
                  {doc.library === "papers" ? "移到图书库" : "移到论文库"}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onClick={() => void trash([doc.id])}
              >
                <Trash2 />
                移到回收站
              </ContextMenuItem>
              {selecting && selected.has(doc.id) && selected.size > 1 && (
                <ContextMenuItem variant="destructive" onClick={removeSelected}>
                  <Trash2 />
                  将所选 {selected.size} 份移到回收站
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      <DocumentOverviewDialog
        key={overviewDocument?.id}
        document={overviewDocument}
        onClose={() => setOverviewDocument(null)}
      />
      <ProcessingUsageDialog
        document={usageDocument}
        job={jobs.find((job) => job.documentId === usageDocument?.id)}
        onClose={() => setUsageDocument(null)}
      />
    </section>
  );
}
