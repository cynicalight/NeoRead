import { BrowserWindow, ipcMain, screen } from "electron";

/** One request's renderer. The main process owns the long-lived subscription. */
export function createCitationWindow(options: {
  url: string;
  token: string;
  preload: string;
  onFailure: () => void;
}) {
  const window = new BrowserWindow({
    title: "引注",
    width: 740,
    height: 740,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setMenu(null);
  window.setAlwaysOnTop(true, "floating");
  // Do not let Electron change the entire app into a macOS accessory app.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    ...(process.platform === "darwin"
      ? { skipTransformProcessType: true }
      : {}),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("closed", () => {
    ipcMain.removeHandler("neoread:citation-visible");
    ipcMain.removeHandler("neoread:citation-size");
  });
  const own = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Invalid sender");
  };
  ipcMain.handle("neoread:citation-visible", (event, visible: unknown) => {
    own(event);
    if (typeof visible !== "boolean") throw new Error("Invalid visibility");
    if (!visible) {
      window.hide();
      return;
    }
    // A panel takes keyboard focus without activating NeoRead.
    window.show();
    window.focus();
  });
  ipcMain.handle(
    "neoread:citation-size",
    (event, width: unknown, height: unknown) => {
      own(event);
      if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !(width > 0 && height > 0)
      )
        throw new Error("Invalid size");
      const visible = window.isVisible();
      const current = window.getBounds();
      // Open on the screen the user clicked the ribbon button on.
      const area = visible
        ? screen.getDisplayMatching(current).workArea
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const w = Math.min(Math.ceil(width), area.width);
      const h = Math.min(Math.ceil(height), area.height);
      const cx = visible
        ? current.x + current.width / 2
        : area.x + area.width / 2;
      const cy = visible
        ? current.y + current.height / 2
        : area.y + area.height / 2;
      const clamp = (value: number, min: number, size: number) =>
        Math.round(Math.max(min, Math.min(value, min + size)));
      window.setBounds({
        x: clamp(cx - w / 2, area.x, area.width - w),
        y: clamp(cy - h / 2, area.y, area.height - h),
        width: w,
        height: h,
      });
    },
  );
  void window
    .loadURL(`${options.url}/?citationWindow=1#token=${options.token}`)
    .catch(options.onFailure);
  return window;
}
