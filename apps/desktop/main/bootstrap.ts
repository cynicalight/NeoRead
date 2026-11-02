import { app, dialog } from "electron";
import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { devIsolation } from "./dev-isolation";
import { readStartupAppearance } from "./startup-appearance-cache";
import { createStartupWindow } from "./startup-window";

type DesktopModule = Pick<typeof import("./index"), "adoptStartupWindow">;

/** Keep business modules out of the path to the first loading-window frame. */
export async function bootstrapDesktop(loadDesktop: () => DesktopModule) {
  const appEvents: EventEmitter = app;
  const startedAt = performance.now();
  const entryMs = Math.round(process.uptime() * 1000);
  const isolation = devIsolation({
    isPackaged: app.isPackaged,
    env: process.env,
  });
  if (isolation.userDataDirectory)
    app.setPath(
      "userData",
      join(app.getPath("appData"), isolation.userDataDirectory),
    );
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let cancelled = false;
  const onQuit = () => {
    cancelled = true;
  };
  app.on("before-quit", onQuit);
  const queued: Array<{ name: string; args: unknown[] }> = [];
  const listeners = [
    "open-file",
    "open-url",
    "second-instance",
    "activate",
  ].map((name) => {
    const listener = (...args: unknown[]) => {
      if (name === "open-file" || name === "open-url")
        (args[0] as { preventDefault: () => void }).preventDefault();
      queued.push({ name, args });
    };
    appEvents.on(name, listener);
    return { name, listener };
  });
  const detach = () => {
    app.removeListener("before-quit", onQuit);
    for (const { name, listener } of listeners)
      appEvents.removeListener(name, listener);
  };
  let startup: ReturnType<typeof createStartupWindow> | undefined;
  try {
    const appearance = readStartupAppearance(app.getPath("userData"));
    await app.whenReady();
    if (cancelled) return;
    startup = createStartupWindow(() => app.quit(), appearance);
    await startup.load();
    if (cancelled) return;
    const desktop = loadDesktop();
    desktop.adoptStartupWindow(startup, startedAt, entryMs);
    detach();
    for (const { name, args } of queued) app.emit(name, ...args);
  } catch {
    if (!cancelled) {
      dialog.showErrorBox(
        "NeoRead 无法启动",
        "请重新打开应用；若仍无法启动，请重新安装。",
      );
      app.quit();
    }
    startup?.dispose();
  } finally {
    detach();
  }
}
