import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@neoread/ui/components/button";
import type { CitePluginStatus } from "./plugins";

const names = { word: "Microsoft Word", wps: "WPS 文字" } as const;

function describe(plugin: CitePluginStatus) {
  if (!plugin.supported) return "当前系统暂不支持。";
  if (!plugin.available) return "这个 Reader 版本没有附带该插件。";
  if (plugin.installed)
    return plugin.kind === "word"
      ? "已安装。重新启动 Word 后，在“Reader”选项卡中插入引注。"
      : "已安装。重新启动 WPS 后，在“Reader”选项卡中插入引注。";
  if (!plugin.detected)
    return plugin.kind === "word"
      ? "未检测到 Word。安装并打开一次 Word 后再安装插件。"
      : "未检测到 WPS。";
  return plugin.kind === "word" ? "安装前请先退出 Word。" : "未安装。";
}

/** Desktop only: installs the Word template and the WPS add-in. */
export function CitePluginSettings({ open }: { open: boolean }) {
  const desktop = window.neoreadDesktop;
  const [plugins, setPlugins] = useState<CitePluginStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !desktop?.citePlugins) return;
    void desktop
      .citePlugins()
      .then(setPlugins)
      .catch(() => setPlugins(null));
  }, [open, desktop]);
  if (!desktop?.citePlugins || !plugins) return null;

  const change = async (plugin: CitePluginStatus, install: boolean) => {
    const action = install
      ? desktop.installCitePlugin
      : desktop.uninstallCitePlugin;
    if (!action) return;
    setBusy(plugin.kind);
    try {
      setPlugins(await action(plugin.kind));
      toast.success(
        install
          ? `已安装 ${names[plugin.kind]} 插件，重新启动 ${names[plugin.kind]} 后生效`
          : `已卸载 ${names[plugin.kind]} 插件`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-5 rounded-md border p-3 text-sm">
      <div className="font-medium">Word / WPS 引用插件</div>
      <p className="mt-1 text-xs text-muted-foreground">
        在文档中插入论文库中的引注和参考文献表。使用时需保持 Reader 运行。
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {plugins.map((plugin) => (
          <li key={plugin.kind} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div>{names[plugin.kind]}</div>
              <p className="text-xs text-muted-foreground">
                {describe(plugin)}
              </p>
            </div>
            {plugin.installed && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void change(plugin, false)}
              >
                卸载
              </Button>
            )}
            {plugin.supported && plugin.available && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void change(plugin, true)}
              >
                {plugin.installed ? "重新安装" : "安装"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
