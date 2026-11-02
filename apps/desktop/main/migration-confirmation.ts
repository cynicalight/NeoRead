import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import { startLibraryRecoveryServer } from "./library-recovery-server";

/** Independent UI: no library, Go service, application preload or API access. */
export async function confirmReaderMigration(
  web: string,
  preload: string,
  resume: boolean,
  signal: AbortSignal,
  parent?: BrowserWindow,
): Promise<boolean> {
  if (signal.aborted) return false;
  const server = await startLibraryRecoveryServer(web);
  let window: BrowserWindow | undefined;
  let cleanup = () => {};
  try {
    if (signal.aborted) return false;
    window = new BrowserWindow({
      parent,
      modal: Boolean(parent),
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const }
        : {}),
      width: 640,
      height: 420,
      show: false,
      resizable: false,
      title: "NeoRead",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#211e21" : "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const dialogWindow = window;
    const url = `${server.url}/migration.html${resume ? "?resume=1" : ""}`;
    dialogWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    dialogWindow.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    const decision = new Promise<boolean>((resolve) => {
      const cancel = () => resolve(false);
      const receive = (event: Electron.IpcMainEvent, value: unknown) => {
        if (
          event.sender === dialogWindow.webContents &&
          event.senderFrame === dialogWindow.webContents.mainFrame &&
          event.senderFrame.url === url &&
          typeof value === "boolean"
        )
          resolve(value);
      };
      ipcMain.on("neoread:migration-decision", receive);
      dialogWindow.once("closed", cancel);
      signal.addEventListener("abort", cancel, { once: true });
      cleanup = () => {
        ipcMain.removeListener("neoread:migration-decision", receive);
        dialogWindow.removeListener("closed", cancel);
        signal.removeEventListener("abort", cancel);
      };
    });
    // Abort also closes a page whose assets have not finished loading.
    const abortWindow = () => {
      if (!dialogWindow.isDestroyed()) dialogWindow.destroy();
    };
    signal.addEventListener("abort", abortWindow, { once: true });
    const previousCleanup = cleanup;
    cleanup = () => {
      previousCleanup();
      signal.removeEventListener("abort", abortWindow);
    };
    await dialogWindow.loadURL(url);
    if (signal.aborted || dialogWindow.isDestroyed()) return false;
    dialogWindow.show();
    return await decision;
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  } finally {
    cleanup();
    if (window && !window.isDestroyed()) window.destroy();
    server.stop();
  }
}
