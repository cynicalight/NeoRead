import { useMemo, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import {
  runLibraryArchive,
  useLibraryArchiveTask,
} from "./library-archive-task";
import { useReaderStore } from "./store";
import { paperCategories } from "./papers/model";
import type {
  LibraryArchiveImportMode,
  LibraryArchiveOptions,
} from "../../../packages/neoread-core/src/library-archive";

export function LibraryArchiveSettings() {
  const desktop = window.neoreadDesktop;
  const documents = useReaderStore((state) => state.documents);
  const preferences = useReaderStore((state) => state.libraryPreferences);
  const categories = useMemo(
    () =>
      paperCategories(
        preferences.papers ?? {},
        documents.filter((doc) => doc.library === "papers"),
      ),
    [documents, preferences],
  );
  const [scope, setScope] = useState("all");
  const [mode, setMode] = useState<LibraryArchiveImportMode>("new");
  const phase = useLibraryArchiveTask((state) => state.phase);
  const busy = ["selecting", "running", "ready", "switching"].includes(phase);
  const error = useLibraryArchiveTask((state) => state.error);
  if (!desktop?.exportLibraryArchive || !desktop.importLibraryArchive)
    return null;
  const perform = async (kind: "export" | "import") => {
    await runLibraryArchive(kind, async (started) => {
      if (kind === "import")
        return await desktop.importLibraryArchive!(mode, started);
      else {
        const smart = preferences.papers?.smartCategories?.find(
          (category) => scope === `smart:${category.id}`,
        );
        const options: LibraryArchiveOptions = smart
          ? { library: "papers", smartCategory: smart.id, name: smart.name }
          : scope.startsWith("folder:")
            ? { library: "papers", folder: scope.slice(7) }
            : scope === "papers" || scope === "books"
              ? { library: scope }
              : {};
        return await desktop.exportLibraryArchive!(options, started);
      }
    });
  };
  return (
    <section>
      <h3 className="mb-3 text-sm font-medium">导出书库</h3>
      <div className="flex items-center gap-2">
        <Select
          value={scope}
          onValueChange={(value) => value && setScope(value)}
          disabled={!!busy}
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label="导出范围">
            <SelectValue>
              {scope === "all"
                ? "全部书库（论文与图书）"
                : scope === "papers"
                  ? "全部论文"
                  : scope === "books"
                    ? "全部图书"
                    : scope.startsWith("folder:")
                      ? `分类：${scope.slice(7)}`
                      : `智能分类：${preferences.papers?.smartCategories?.find((category) => `smart:${category.id}` === scope)?.name ?? ""}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部书库（论文与图书）</SelectItem>
            <SelectItem value="papers">全部论文</SelectItem>
            <SelectItem value="books">全部图书</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category} value={`folder:${category}`}>
                分类：{category}
              </SelectItem>
            ))}
            {preferences.papers?.smartCategories?.map((category) => (
              <SelectItem key={category.id} value={`smart:${category.id}`}>
                智能分类：{category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={() => void perform("export")}
        >
          <Download />
          导出书库
        </Button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        打包原文件、译文、公式、批注、笔记、对话、阅读记录与分类。分类导出包含子分类，可选择
        ZIP 保存位置。保存当前阅读状态后打包，应用和当前 AI 调用继续运行。
      </p>
      <h3 className="mb-3 mt-5 text-sm font-medium">导入书库压缩包</h3>
      <div className="flex items-center gap-2">
        <Select
          value={mode}
          onValueChange={(value) =>
            value && setMode(value as LibraryArchiveImportMode)
          }
          disabled={!!busy}
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label="导入方式">
            <SelectValue>
              {mode === "new" ? "新建书库并切换" : "合并到当前书库"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">新建书库并切换</SelectItem>
            <SelectItem value="merge">合并到当前书库</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={() => void perform("import")}
        >
          <Upload />
          导入压缩包
        </Button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {mode === "new"
          ? "选择 ZIP 后自动新建书库，完整还原压缩包内容并切换。"
          : "合并结果保存为新书库并切换，已有文档保留；同一文档以压缩包中的版本为准。"}
        原书库保留，可从左上角切换回来。AI 账户与 API
        密钥需在目标机器上单独配置。
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
