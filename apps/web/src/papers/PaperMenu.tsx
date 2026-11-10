import {
  ArrowRightLeft,
  BookOpen,
  ExternalLink,
  FileDown,
  FolderOpen,
  FolderPlus,
  Link2,
  Paperclip,
  Pin,
  RefreshCw,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { neoreadLink, type Document, type ReadingStatus } from "@neoread/core";
import { copyText } from "../chat/clipboard";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@neoread/ui/components/context-menu";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@neoread/ui/components/dropdown-menu";
import { useReaderStore } from "../store";
import {
  addToCategory,
  removeFromCategory,
  revealFile,
  openLink,
  savePaperPreferences,
  setReadingStatus,
  setStarred,
  toggleTagFor,
} from "./actions";
import { paperLink } from "./format";
import { exportAnnotatedPDFWithToast } from "../annotated-pdf-export";
import { reparseDocument } from "../reparse-document";
import { CitationMenuItems } from "./CitationMenu";
import {
  categoryTree,
  flattenCategories,
  hasTag,
  paperCategories,
  paperTags,
  statusLabels,
  togglePinned,
} from "./model";

const kits = {
  context: {
    Item: ContextMenuItem,
    Checkbox: ContextMenuCheckboxItem,
    RadioGroup: ContextMenuRadioGroup,
    Radio: ContextMenuRadioItem,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Item: DropdownMenuItem,
    Checkbox: DropdownMenuCheckboxItem,
    RadioGroup: DropdownMenuRadioGroup,
    Radio: DropdownMenuRadioItem,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
};

export interface PaperMenuActions {
  open: (doc: Document) => void;
  export: (doc: Document) => void;
  move: (doc: Document) => void;
  trash: (docs: Document[]) => void;
  newCategory: (docs: Document[]) => void;
  newTag: (docs: Document[]) => void;
  addAttachment?: (doc: Document, kind: "file" | "link") => void;
}

/** Menu items for one paper, or for every picked paper when it is picked. */
export function PaperMenuItems({
  kind,
  docs,
  actions,
  extra,
  inPanel = false,
}: {
  kind: keyof typeof kits;
  docs: Document[];
  actions: PaperMenuActions;
  extra?: React.ReactNode;
  /** The detail panel has its own open, star and pin buttons. */
  inPanel?: boolean;
}) {
  const K = kits[kind];
  const all = useReaderStore((s) => s.documents);
  const prefs = useReaderStore((s) => s.libraryPreferences.papers) || {};
  const categories = paperCategories(
    prefs,
    all.filter((d) => d.library === "papers"),
  );
  const tags = paperTags(all.filter((d) => d.library === "papers"));
  const one = docs.length === 1 ? docs[0] : undefined;
  const starred = docs.every((d) => d.favorite);
  const status = docs.every((d) => d.readingStatus === docs[0].readingStatus)
    ? docs[0].readingStatus
    : "";
  const pinKey = one ? `doc:${one.id}` : "";
  const link = one ? paperLink(one.metadata) : "";
  return (
    <>
      {kind === "dropdown" && !inPanel && (
        <>
          {one && (
            <K.Item onClick={() => actions.open(one)}>
              <BookOpen />
              打开阅读
            </K.Item>
          )}
          <K.Item onClick={() => void setStarred(docs, !starred)}>
            <Star />
            {starred ? "取消星标" : "加星标"}
          </K.Item>
          {one && (
            <K.Item
              onClick={() =>
                void savePaperPreferences((p) => togglePinned(p, pinKey))
              }
            >
              <Pin />
              {prefs.pinned?.includes(pinKey) ? "取消置顶" : "置顶到侧栏"}
            </K.Item>
          )}
          <K.Separator />
        </>
      )}
      {kind === "dropdown" && (
        <>
          <K.Sub>
            <K.SubTrigger>分类</K.SubTrigger>
            <K.SubContent className="max-h-80 min-w-44">
              {flattenCategories(categoryTree(categories)).map((node) => {
                const { name } = node;
                const inside = docs.every((d) =>
                  d.folders.some((f) => f.toLowerCase() === name.toLowerCase()),
                );
                return (
                  <K.Checkbox
                    key={name}
                    checked={inside}
                    onCheckedChange={() =>
                      void (inside
                        ? removeFromCategory(docs, name)
                        : addToCategory(docs, name))
                    }
                  >
                    <span
                      className="truncate"
                      style={{ paddingLeft: node.depth * 12 }}
                    >
                      {node.label}
                    </span>
                  </K.Checkbox>
                );
              })}
              {categories.length > 0 && <K.Separator />}
              <K.Item onClick={() => actions.newCategory(docs)}>
                <FolderPlus />
                新建分类并放入…
              </K.Item>
            </K.SubContent>
          </K.Sub>
          <K.Sub>
            <K.SubTrigger>标签</K.SubTrigger>
            <K.SubContent className="max-h-80 min-w-44">
              {tags.map((tag) => {
                const on = docs.every((d) => hasTag(d, tag));
                return (
                  <K.Checkbox
                    key={tag}
                    checked={on}
                    onCheckedChange={() => void toggleTagFor(docs, tag)}
                  >
                    <span className="truncate">#{tag}</span>
                  </K.Checkbox>
                );
              })}
              {tags.length > 0 && <K.Separator />}
              <K.Item onClick={() => actions.newTag(docs)}>
                <Tag />
                新标签…
              </K.Item>
            </K.SubContent>
          </K.Sub>
          <K.Sub>
            <K.SubTrigger>阅读状态</K.SubTrigger>
            <K.SubContent>
              <K.RadioGroup
                value={status}
                onValueChange={(value: string) =>
                  void setReadingStatus(docs, value as ReadingStatus)
                }
              >
                {(Object.keys(statusLabels) as ReadingStatus[]).map((key) => (
                  <K.Radio key={key} value={key}>
                    {statusLabels[key]}
                  </K.Radio>
                ))}
              </K.RadioGroup>
            </K.SubContent>
          </K.Sub>
        </>
      )}
      {one && one.type === "pdf" && actions.addAttachment && (
        <K.Sub>
          <K.SubTrigger>
            <Paperclip />
            添加附件
          </K.SubTrigger>
          <K.SubContent>
            <K.Item onClick={() => actions.addAttachment?.(one, "file")}>
              添加文件…
            </K.Item>
            <K.Item onClick={() => actions.addAttachment?.(one, "link")}>
              添加链接…
            </K.Item>
          </K.SubContent>
        </K.Sub>
      )}
      {kind === "dropdown" && (
        <CitationMenuItems kind={kind} docs={docs} nested />
      )}
      {extra}
      {one && (
        <>
          <K.Separator />
          <K.Item onClick={() => void reparseDocument(one)}>
            <RefreshCw />
            重新解析
          </K.Item>
          {kind === "dropdown" && (
            <>
              <K.Item
                onClick={() =>
                  void copyText(neoreadLink({ id: one.id }), "已复制阅读链接")
                }
              >
                <Link2 />
                复制阅读链接
              </K.Item>
              {link && (
                <K.Item onClick={() => openLink(link)}>
                  <ExternalLink />
                  打开论文主页
                </K.Item>
              )}
            </>
          )}
          {window.neoreadDesktop?.showDocumentFile && (
            <K.Item onClick={() => revealFile(one)}>
              <FolderOpen />
              {window.neoreadDesktop.platform === "darwin"
                ? "在 Finder 中显示"
                : "在文件夹中显示"}
            </K.Item>
          )}
          {kind === "context" && (
            <K.Item onClick={() => actions.export(one)}>
              <FileDown />
              导出…
            </K.Item>
          )}
          {kind === "dropdown" && one.type === "pdf" && (
            <K.Item onClick={() => void exportAnnotatedPDFWithToast(one)}>
              <FileDown />
              导出带批注的 PDF
            </K.Item>
          )}
          <K.Item onClick={() => actions.move(one)}>
            <ArrowRightLeft />
            移到图书库
          </K.Item>
        </>
      )}
      {(kind === "dropdown" || one || extra) && <K.Separator />}
      <K.Item variant="destructive" onClick={() => actions.trash(docs)}>
        <Trash2 />
        {docs.length > 1 ? `将 ${docs.length} 篇移到回收站` : "移到回收站"}
      </K.Item>
    </>
  );
}
