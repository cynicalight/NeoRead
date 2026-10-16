import { EndNoteSourcePicker } from "./EndNoteSourcePicker";
import { confirmLargePaper } from "../LargePaperDialog";
import { useEffect, useRef, useState } from "react";
import { Download, FolderOpen, Loader2 } from "lucide-react";
import {
  api,
  RequestError,
  type ZoteroImportResult,
  type ZoteroScan,
} from "@reader/api";
import { Button } from "@reader/ui/components/button";
import { Checkbox } from "@reader/ui/components/checkbox";
import { Input } from "@reader/ui/components/input";
import { Progress } from "@reader/ui/components/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@reader/ui/components/dialog";
import { refreshLibrary } from "../store";
import { downloadText } from "../download";

type Outcome = ZoteroImportResult | { status: "failed"; error: string };
const statusLabels = {
  imported: "已导入",
  merged: "已合并到现有文件",
  exists: "已迁移，跳过",
  failed: "导入失败",
};

export function ZoteroImportDialog({
  open,
  onOpenChange,
  source = "zotero",
}: {
  source?: "zotero" | "endnote";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const endnote = source === "endnote";
  const sourceName = endnote ? "EndNote" : "Zotero";
  const [directory, setDirectory] = useState("");
  const [linkedBase, setLinkedBase] = useState("");
  const [scan, setScan] = useState<ZoteroScan>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [phase, setPhase] = useState<
    "source" | "scanning" | "preview" | "running" | "finished"
  >("source");
  const [error, setError] = useState("");
  const [current, setCurrent] = useState("");
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [visibleCount, setVisibleCount] = useState(100);
  const [query, setQuery] = useState("");
  const stop = useRef(false);
  const busy = phase === "scanning" || phase === "running";
  useEffect(() => {
    let active = true;
    if (!endnote)
      void api.zoteroDefaults().then(
        ({ directory }) => {
          if (active) setDirectory((previous) => previous || directory);
        },
        () => {},
      );
    return () => {
      active = false;
      stop.current = true;
    };
  }, []);

  const chooseDirectory = async (linked: boolean) => {
    try {
      const path = await window.readerDesktop?.chooseZoteroDirectory?.();
      if (path) (linked ? setLinkedBase : setDirectory)(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const scanLibrary = async (path = directory) => {
    setDirectory(path);
    setError("");
    setPhase("scanning");
    try {
      const result = await (endnote
        ? api.scanEndNote(path.trim())
        : api.scanZotero(path.trim(), linkedBase.trim()));
      setScan(result);
      setSelected(
        new Set(
          result.entries
            .filter((entry) => !entry.issue)
            .map((entry) => entry.id),
        ),
      );
      setOutcomes({});
      setVisibleCount(100);
      setPhase("preview");
    } catch (e) {
      setError((e as Error).message);
      setPhase("source");
    }
  };
  const startImport = async () => {
    if (!scan || selected.size === 0 || busy) return;
    const entries = scan.entries.filter(
      (entry) => selected.has(entry.id) && !entry.issue && !outcomes[entry.id],
    );
    if (!entries.length) return;
    stop.current = false;
    setStopping(false);
    setError("");
    setCompleted(0);
    setTotal(entries.length);
    setPhase("running");
    for (const entry of entries) {
      if (stop.current) break;
      setCurrent(entry.title);
      let result: Outcome;
      try {
        try {
          result = await (endnote ? api.importEndNote : api.importZotero)(
            scan.id,
            entry.id,
          );
        } catch (error) {
          if (!(error instanceof RequestError) || error.code !== "large-paper")
            throw error;
          const library = await confirmLargePaper();
          if (!library) {
            stop.current = true;
            break;
          }
          result = await (endnote ? api.importEndNote : api.importZotero)(
            scan.id,
            entry.id,
            {
              library,
              allowLarge: true,
            },
          );
        }
      } catch (e) {
        result = { status: "failed", error: (e as Error).message };
      }
      setOutcomes((previous) => ({ ...previous, [entry.id]: result }));
      setCompleted((count) => count + 1);
    }
    setCurrent("");
    try {
      await refreshLibrary();
    } catch {
      setError("导入结果已保存，但书库刷新失败，请重新打开书库。");
    }
    setPhase("finished");
  };
  const exportReport = () => {
    if (!scan) return;
    downloadText(
      JSON.stringify(
        {
          source: scan.directory,
          exportedAt: new Date().toISOString(),
          warnings: scan.warnings,
          entries: scan.entries.map((entry) => ({
            ...entry,
            outcome: outcomes[entry.id] || {
              status: entry.issue ? "unavailable" : "notImported",
            },
          })),
        },
        null,
        2,
      ),
      `${source}-migration-report.json`,
      "application/json",
    );
  };
  const ready = scan?.entries.filter((entry) => !entry.issue) || [];
  const visible =
    scan?.entries.filter((entry) =>
      `${entry.title} ${entry.filename} ${entry.collections.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  const counts = Object.values(outcomes).reduce(
    (counts, result) => {
      counts[result.status] += 1;
      return counts;
    },
    { imported: 0, merged: 0, exists: 0, failed: 0 },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>从 {sourceName} 导入</DialogTitle>
          <DialogDescription>
            {endnote
              ? "复制本机 PDF、论文信息、标签和笔记，将支持的 PDF 标记转换为 Reader 批注并清除副本中的对应标记。EndNote 源数据保持不变。"
              : "复制本机 PDF、论文信息、分类、标签、笔记和可转换的批注。Zotero 原数据保持不变。"}
          </DialogDescription>
        </DialogHeader>
        {!scan ? (
          endnote ? (
            <EndNoteSourcePicker
              busy={busy}
              onConfirm={(path) => void scanLibrary(path)}
            />
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void scanLibrary();
              }}
            >
              <div className="grid gap-2">
                <label
                  htmlFor="zotero-directory"
                  className="text-sm font-medium"
                >
                  Zotero 资料目录
                </label>
                <div className="flex gap-2">
                  <Input
                    id="zotero-directory"
                    value={directory}
                    disabled={busy}
                    onChange={(event) => setDirectory(event.target.value)}
                    placeholder="包含 zotero.sqlite 和 storage 的目录"
                  />
                  {window.readerDesktop?.chooseZoteroDirectory && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      aria-label="选择 Zotero 资料目录"
                      onClick={() => void chooseDirectory(false)}
                    >
                      <FolderOpen />
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  可在 Zotero「设置 → 高级 →
                  资料目录」查看。先下载所需附件，再完全退出 Zotero
                  后扫描（macOS 按 ⌘Q，关闭窗口不等于退出）。
                </p>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  使用链接附件
                </summary>
                <div className="mt-3 grid gap-2">
                  <label htmlFor="zotero-linked-base">
                    链接附件基目录（可选）
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="zotero-linked-base"
                      value={linkedBase}
                      placeholder="留空自动识别，或手动指定目录"
                      disabled={busy}
                      onChange={(event) => setLinkedBase(event.target.value)}
                    />
                    {window.readerDesktop?.chooseZoteroDirectory && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        aria-label="选择链接附件基目录"
                        onClick={() => void chooseDirectory(true)}
                      >
                        <FolderOpen />
                      </Button>
                    )}
                  </div>
                </div>
              </details>
              <p className="text-muted-foreground text-xs">
                富文本笔记转为纯文本。手绘、图片和无法定位的批注保留文本与原始位置；图片本身不迁移。仅有元数据、独立笔记和独立附件暂不导入。
              </p>
              <Button type="submit" disabled={busy || !directory.trim()}>
                {busy && <Loader2 className="animate-spin" />}
                {busy ? "扫描中" : "扫描资料库"}
              </Button>
            </form>
          )
        ) : (
          <div className="grid min-w-0 gap-3">
            <p className="text-sm">
              共 {scan.entries.length} 条附件或论文记录，可导入 {ready.length}{" "}
              条，需处理 {scan.entries.length - ready.length} 条。
            </p>
            {scan.warnings.map((warning) => (
              <p key={warning} className="text-muted-foreground text-xs">
                {warning}
              </p>
            ))}
            <p className="text-muted-foreground text-xs">
              同一论文的多个 PDF 分别导入。超过 100 页或 100 MB
              时需确认是否是论文。自动翻译遵循设置中的页数上限。
            </p>
            {phase === "running" && (
              <div role="status" className="grid gap-2">
                <p className="truncate text-sm">
                  {stopping ? "正在完成当前附件…" : current}（{completed}/
                  {total}）
                </p>
                <Progress value={total ? (completed / total) * 100 : 0} />
              </div>
            )}
            {phase === "finished" && (
              <p role="status" className="text-sm">
                新增 {counts.imported}，合并 {counts.merged}，已迁移{" "}
                {counts.exists}，失败 {counts.failed}。
                {stopping && "已停止后续导入。"}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Input
                aria-label={`筛选 ${sourceName} 记录`}
                placeholder="筛选标题或分类"
                value={query}
                disabled={busy}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(100);
                }}
              />
              {phase === "preview" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelected(
                      new Set(
                        selected.size === ready.length
                          ? []
                          : ready.map((entry) => entry.id),
                      ),
                    )
                  }
                >
                  {selected.size === ready.length ? "取消全选" : "全选可导入"}
                </Button>
              )}
            </div>
            <ul
              className="grid max-h-72 gap-1 overflow-y-auto rounded-md border p-2"
              aria-label={`${sourceName} 迁移记录`}
            >
              {visible.slice(0, visibleCount).map((entry) => {
                const result = outcomes[entry.id];
                const warnings =
                  result && result.status !== "failed"
                    ? result.warnings
                    : entry.warnings;
                return (
                  <li key={entry.id} className="flex min-w-0 gap-3 rounded p-2">
                    <Checkbox
                      aria-label={`导入 ${entry.title}（${entry.filename || entry.id}）`}
                      disabled={phase !== "preview" || !!entry.issue}
                      checked={selected.has(entry.id)}
                      onCheckedChange={(checked) =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        })
                      }
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="truncate font-medium" title={entry.title}>
                        {entry.title}
                      </p>
                      <p
                        className="text-muted-foreground truncate text-xs"
                        title={entry.filename}
                      >
                        {entry.filename || "无 PDF"}
                        {entry.collections.length > 0 &&
                          ` · ${entry.collections.join("、")}`}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {result
                          ? statusLabels[result.status]
                          : entry.issue ||
                            (endnote
                              ? `${entry.notes} 条笔记 · 导入时识别 PDF 批注`
                              : `${entry.notes} 条笔记 · ${entry.annotations} 条批注`)}
                      </p>
                      {result?.status === "failed" && (
                        <p className="text-destructive text-xs">
                          {result.error}
                        </p>
                      )}
                      {warnings.length > 0 && (
                        <details className="mt-1 text-xs text-muted-foreground">
                          <summary className="cursor-pointer">
                            {warnings.length} 项说明
                          </summary>
                          <ul className="mt-1 grid gap-1">
                            {warnings.map((warning, index) => (
                              <li key={index}>{warning}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
              {!visible.length && (
                <li className="p-3 text-sm text-muted-foreground">
                  没有符合条件的记录。
                </li>
              )}
              {visible.length > visibleCount && (
                <li>
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => setVisibleCount((value) => value + 100)}
                  >
                    显示更多（剩余 {visible.length - visibleCount}）
                  </Button>
                </li>
              )}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              {phase !== "running" && (
                <Button variant="outline" onClick={exportReport}>
                  <Download />
                  导出报告
                </Button>
              )}
              {phase === "running" ? (
                <Button
                  variant="outline"
                  disabled={stopping}
                  onClick={() => {
                    stop.current = true;
                    setStopping(true);
                  }}
                >
                  停止后续导入
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    setScan(undefined);
                    setPhase("source");
                    setError("");
                    setQuery("");
                  }}
                >
                  重新扫描
                </Button>
              )}
              {phase === "preview" && (
                <Button
                  disabled={selected.size === 0}
                  onClick={() => void startImport()}
                >
                  导入选中 {selected.size} 条
                </Button>
              )}
              {phase === "finished" && (
                <Button onClick={() => onOpenChange(false)}>完成</Button>
              )}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
