import { BrowserWindow, nativeTheme } from "electron";
import { createHash } from "node:crypto";
import { createStartupHTML, startupAnimationScript } from "./startup-animation";
import type { StartupAppearance } from "./startup-appearance-cache";

declare const NEOREAD_STARTUP_ASSETS: Parameters<typeof createStartupHTML>[0];

// ready-to-show/loadURL can precede visible content. Observe the first content
// paint before starting the mandatory display interval, without a preload/IPC.
const firstContentPaint = `new Promise(resolve => {
  if (performance.getEntriesByType("paint").some(entry => entry.name === "first-contentful-paint")) {
    resolve(); return;
  }
  const observer = new PerformanceObserver(list => {
    if (list.getEntries().some(entry => entry.name === "first-contentful-paint")) {
      observer.disconnect(); resolve();
    }
  });
  observer.observe({ type: "paint", buffered: true });
})`;

// Independent of Go, user data and the application bundle. No preload or IPC.
export function createStartupWindow(
  onClose: () => void,
  appearance: StartupAppearance = "system",
) {
  const dark =
    appearance === "dark" ||
    (appearance === "system" && nativeTheme.shouldUseDarkColors);
  nativeTheme.themeSource = appearance === "sepia" ? "light" : appearance;
  const loading = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 660,
    title: "NeoRead",
    backgroundColor: dark ? "#211e21" : "#ffffff",
    skipTaskbar: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 20, y: 20 },
        }
      : { autoHideMenuBar: true }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loading.on("close", onClose);
  loading.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  loading.webContents.on("will-navigate", (event) => event.preventDefault());
  let visibleAt: number | undefined;
  let cancelMinimum: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    loading.once("ready-to-show", () => {
      resolve();
    });
  });
  const closed = new Promise<never>((_resolve, reject) => {
    loading.once("closed", () => {
      cancelMinimum?.();
      reject(new Error("Startup window closed"));
    });
  });
  // Closing before load() is also a normal cancellation path.
  void closed.catch(() => {});
  let loaded: Promise<void> | undefined;
  return {
    nativeWindow: loading,
    load() {
      return (loaded ??= Promise.race([
        closed,
        Promise.all([
          ready,
          loading.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(
              startupHTML.replace(
                '<html lang="zh-CN">',
                `<html lang="zh-CN" data-startup-theme="${dark ? "dark" : "light"}">`,
              ),
            )}`,
          ),
        ])
          .then(() => loading.webContents.executeJavaScript(firstContentPaint))
          .then(() => {
            visibleAt = performance.now();
          }),
      ]));
    },
    async waitForMinimumDisplay() {
      if (!loaded) throw new Error("Startup page not loaded");
      await loaded;
      if (loading.isDestroyed()) return;
      const remaining = 500 - (performance.now() - visibleAt!);
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelMinimum = undefined;
          resolve();
        }, remaining);
        cancelMinimum = () => {
          clearTimeout(timer);
          cancelMinimum = undefined;
          resolve();
        };
      });
    },
    dispose() {
      cancelMinimum?.();
      loading.removeListener("close", onClose);
      if (!loading.isDestroyed()) loading.destroy();
    },
  };
}

// Assets are embedded by esbuild; tests can render the static fallback too.
const assets =
  typeof NEOREAD_STARTUP_ASSETS === "undefined"
    ? { fontDataURL: "", logoLightDataURL: "", logoDarkDataURL: "" }
    : NEOREAD_STARTUP_ASSETS;
const scriptHash = createHash("sha256")
  .update(startupAnimationScript)
  .digest("base64");
const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'`;
export const startupHTML = createStartupHTML(assets).replace(
  "<head>",
  `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
);
