import type { IpcMain, WebContents } from "electron";

/** Reuse the renderer's close-time save without closing its window. */
export function flushLibraryWindow(ipc: IpcMain, contents: WebContents) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ipc.removeListener("neoread:flushed", receive);
      if (error) reject(error);
      else resolve();
    };
    const receive = (
      event: Electron.IpcMainEvent,
      error: string | null,
      discarded?: boolean,
    ) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame)
        return;
      finish(
        error
          ? new Error(error)
          : discarded
            ? new Error("论文笔记尚未保存，请保存后再处理书库。")
            : undefined,
      );
    };
    const timer = setTimeout(
      () => finish(new Error("阅读状态保存超时，请重试。")),
      10000,
    );
    ipc.on("neoread:flushed", receive);
    contents.send("neoread:flush");
  });
}
