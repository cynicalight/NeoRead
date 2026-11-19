import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@neoread/ui/components/tabs";
import { LibraryLocationSettings } from "./LibraryLocationSettings";

/** The recovery settings work without mounting App or making library API requests. */
export function LibraryRecoverySettings() {
  const [warning, setWarning] = useState(
    "无法访问已设置的书库，请重新连接存储设备、导入已有书库，或新建书库。",
  );
  const [resetError, setResetError] = useState("");
  const resetLibrary = async () => {
    setResetError("");
    try {
      await window.neoreadDesktop?.resetLibrary?.();
    } catch (error) {
      setResetError((error as Error).message);
    }
  };
  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle("dark", preference.matches);
    apply();
    preference.addEventListener("change", apply);
    return () => preference.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    void window.neoreadDesktop
      ?.libraryWarning?.()
      .then(setWarning)
      .catch(() => {});
  }, []);
  return (
    <main className="h-screen bg-background text-foreground">
      <div
        className="h-14"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <Dialog open onOpenChange={(_, details) => details.cancel()}>
        <DialogContent
          showCloseButton={false}
          className="settings-dialog p-6 sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>连接书库后即可继续阅读。</DialogDescription>
          </DialogHeader>
          <Tabs value="papers">
            <TabsList>
              <TabsTrigger value="papers">论文库</TabsTrigger>
            </TabsList>
            <TabsContent value="papers" className="settings-panel">
              <div role="alert" className="mb-6 rounded-md border p-3 text-sm">
                <div className="mb-2 flex items-center gap-2">
                  <TriangleAlert className="size-4" />
                  书库暂时无法访问
                </div>
                <p className="break-all text-xs leading-5 text-muted-foreground">
                  {warning}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void window.neoreadDesktop?.restart?.()}
                  >
                    重新连接后重试
                  </Button>
                  {window.neoreadDesktop?.resetLibrary && (
                    <Button
                      variant="outline"
                      onClick={() => void resetLibrary()}
                    >
                      新建书库
                    </Button>
                  )}
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  原书库已删除或无法恢复时，可新建书库继续使用；原书库找回后仍可导入。
                </p>
                {resetError && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {resetError}
                  </p>
                )}
              </div>
              <LibraryLocationSettings open recovery />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </main>
  );
}
