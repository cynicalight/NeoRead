import {
  ArrowRightLeft,
  BookOpen,
  ChartColumn,
  FileDown,
  FolderOpen,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { Document, LibraryMode } from "@neoread/core";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@neoread/ui/components/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@neoread/ui/components/dropdown-menu";
import { exportAnnotatedPDFWithToast } from "./annotated-pdf-export";
import { reparseDocument } from "./reparse-document";
import { revealFile } from "./papers/actions";

const kits = {
  context: { Item: ContextMenuItem, Separator: ContextMenuSeparator },
  dropdown: { Item: DropdownMenuItem, Separator: DropdownMenuSeparator },
};

export interface BookMenuActions {
  overview: (doc: Document) => void;
  usage: (doc: Document) => void;
  move?: (doc: Document, library: LibraryMode) => void;
  trash: (doc: Document) => void;
}

/** Menu items for one document in the book library. */
export function BookMenuItems({
  kind,
  doc,
  actions,
}: {
  kind: keyof typeof kits;
  doc: Document;
  actions: BookMenuActions;
}) {
  const K = kits[kind];
  return (
    <>
      <K.Item onClick={() => actions.overview(doc)}>
        <BookOpen />
        文档概要
      </K.Item>
      {kind === "context" && (
        <K.Item onClick={() => actions.usage(doc)}>
          <ChartColumn />
          用量统计
        </K.Item>
      )}
      <K.Item onClick={() => void reparseDocument(doc)}>
        <RefreshCw />
        重新解析
      </K.Item>
      {window.neoreadDesktop?.showDocumentFile && (
        <K.Item onClick={() => revealFile(doc)}>
          <FolderOpen />
          {window.neoreadDesktop.platform === "darwin"
            ? "在 Finder 中显示"
            : "在文件夹中显示"}
        </K.Item>
      )}
      {doc.type === "pdf" && (
        <K.Item onClick={() => void exportAnnotatedPDFWithToast(doc)}>
          <FileDown />
          导出带批注的 PDF
        </K.Item>
      )}
      {actions.move && (doc.type === "pdf" || doc.library === "papers") && (
        <K.Item
          onClick={() =>
            actions.move!(doc, doc.library === "papers" ? "books" : "papers")
          }
        >
          <ArrowRightLeft />
          {doc.library === "papers" ? "移到图书库" : "移到论文库"}
        </K.Item>
      )}
      <K.Separator />
      <K.Item variant="destructive" onClick={() => actions.trash(doc)}>
        <Trash2 />
        移到回收站
      </K.Item>
    </>
  );
}
