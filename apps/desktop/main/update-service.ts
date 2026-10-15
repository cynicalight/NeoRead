import { app, autoUpdater, BrowserWindow, dialog, net, shell } from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canUpdateInPlace, stageUpdate } from "./mac-squirrel";
import {
  DailyUpdateChecker,
  type ReleaseUpdate,
  type UpdateState,
} from "./updates";
import { downloadUpdate, type DownloadProgress } from "./update-download";
import type { UpdateProgress } from "../../../packages/reader-core/src/update-progress";

export async function startUpdateService(window: BrowserWindow) {
  const directory = app.getPath("userData");
  const statePath = join(directory, "update-state.json");
  let state: UpdateState = {};
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    for (const key of ["lastChecked", "lastAttempt"] as const) {
      if (
        typeof saved?.[key] === "number" &&
        Number.isFinite(saved[key]) &&
        saved[key] >= 0
      )
        state[key] = saved[key];
    }
  } catch {
    /* Missing or corrupt scheduler state is safe to replace. */
  }
  const checker = new DailyUpdateChecker({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    state,
    fetch: (url, init) => net.fetch(url, init),
    save: async (value) => {
      await mkdir(directory, { recursive: true });
      await writeFile(`${statePath}.tmp`, JSON.stringify(value), {
        mode: 0o600,
      });
      await rename(`${statePath}.tmp`, statePath);
    },
  });
  let active: Promise<void> | undefined;
  let stopped = false;
  let wantsFeedback = false;
  let staged: string | undefined;
  let installer: string | undefined;
  // NSIS kills whatever still runs from the install folder, so the installer
  // starts only after the reading flush and server shutdown have finished.
  const runInstaller = () => {
    if (!installer) return;
    try {
      // --updated keeps shortcuts and user data; --force-run reopens Reader.
      spawn(installer, ["--updated", "/S", "--force-run"], {
        detached: true,
        stdio: "ignore",
      })
        .on("error", (error) =>
          console.warn("Reader installer:", error.message),
        )
        .unref();
    } catch (error) {
      console.warn(
        "Reader installer:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const alive = () => !stopped && !window.isDestroyed();
  // Mirrors visible update work in the taskbar or Dock and the in-app toast.
  const report = (progress: UpdateProgress | null) => {
    if (window.isDestroyed()) return;
    window.setProgressBar(
      !progress
        ? -1
        : progress.phase === "download" && progress.total
          ? // A mismatched Content-Length must not overflow the bar.
            Math.min(1, progress.received / progress.total)
          : 2,
    );
    window.webContents.send("reader:update-progress", progress);
  };
  // Reports whole-percent steps (or 1 MB steps without a size) while visible.
  const track = (version: string): DownloadProgress => {
    let last = -1;
    return (received, total) => {
      if (!wantsFeedback) return;
      const step = total
        ? Math.floor((received / total) * 100)
        : Math.floor(received / (1024 * 1024));
      if (step === last) return;
      last = step;
      report({ version, phase: "download", received, total });
    };
  };
  const request = (url: string, init: RequestInit) => net.fetch(url, init);
  const offerRestart = async (version: string) => {
    const selected = await dialog.showMessageBox(window, {
      type: "info",
      message: `Reader ${version} 已准备就绪`,
      detail:
        "重启 Reader 即可完成更新。选择“稍后”时，会在退出 Reader 后自动安装。",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
    });
    // Windows still close through the normal flush before Squirrel replaces the app.
    if (selected.response === 0 && alive()) autoUpdater.quitAndInstall();
  };
  // Returns false when the app cannot replace itself; the caller then offers the DMG.
  const updateInPlace = async (update: ReleaseUpdate): Promise<boolean> => {
    if (!update.archive) return false;
    if (staged === update.version) {
      if (wantsFeedback) await offerRestart(update.version);
      return true;
    }
    try {
      const bundle = join(app.getPath("exe"), "..", "..", "..");
      if (!(await canUpdateInPlace(bundle))) return false;
      // A manual check during a silent download reveals its progress.
      const archive = await downloadUpdate(
        { ...update, ...update.archive },
        join(directory, "updates"),
        request,
        track(update.version),
      );
      try {
        if (!alive()) return true;
        if (wantsFeedback)
          report({ version: update.version, phase: "prepare", received: 0 });
        await stageUpdate(autoUpdater, archive);
        staged = update.version;
      } finally {
        // Squirrel keeps its own copy of a staged update.
        await rm(dirname(archive), { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(
        "Reader in-place update:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      report(null);
    }
    if (alive()) await offerRestart(update.version);
    return true;
  };
  const check = (manual = false): Promise<void> => {
    if (active) {
      wantsFeedback ||= manual;
      return active;
    }
    if (!alive() || (!manual && !checker.isDue())) return Promise.resolve();
    if (!app.isPackaged) {
      return manual
        ? dialog
            .showMessageBox(window, {
              message: "开发模式不检查更新",
              detail: "请在安装后的 Reader 中检查更新。",
            })
            .then(() => {})
        : Promise.resolve();
    }
    wantsFeedback = manual;
    active = (async () => {
      let downloading = false;
      try {
        const result = await checker.check();
        if (!alive()) return;
        if (result.status !== "available") {
          if (wantsFeedback || downloading)
            await dialog.showMessageBox(window, {
              message:
                result.status === "pending"
                  ? "新版本安装包正在准备中"
                  : "当前已是最新正式版",
              detail:
                result.status === "pending"
                  ? "安装包上传完成后会再次检查，你也可以稍后手动重试。"
                  : `当前版本：${app.getVersion()}`,
            });
          return;
        }
        if (
          process.platform === "darwin" &&
          (await updateInPlace(result.update))
        )
          return;
        if (!alive()) return;
        const windows = process.platform === "win32";
        const selected = await dialog.showMessageBox(window, {
          type: "info",
          message: `Reader ${result.update.version} 可用`,
          detail: `${
            windows
              ? `当前版本：${app.getVersion()}。下载并校验后，Reader 会保存阅读数据并退出，自动安装后重新打开。`
              : `当前版本：${app.getVersion()}。下载并校验后将打开 DMG，请将 Reader 拖入 Applications 完成更新。安装前请退出当前 Reader。`
          }\n\n安装包从 GitHub 下载，速度较慢时可开启代理加速。`,
          buttons: [windows ? "下载并安装" : "下载安装包", "稍后"],
          defaultId: 0,
          cancelId: 1,
        });
        if (selected.response !== 0 || !alive()) return;
        downloading = true;
        // The user asked for this download, so its progress is shown.
        wantsFeedback = true;
        const path = await downloadUpdate(
          result.update,
          join(directory, "updates"),
          request,
          track(result.update.version),
        );
        if (!alive()) return;
        if (windows) {
          // A cancelled quit leaves the installer armed for the next quit.
          if (!installer) app.once("quit", runInstaller);
          installer = path;
          app.quit();
          return;
        }
        const error = await shell.openPath(path);
        if (error) throw new Error(`无法打开安装包：${error}`);
      } catch (error) {
        // Clear the progress before the error dialog so it does not linger.
        report(null);
        if (alive()) {
          if (wantsFeedback || downloading) {
            const selected = await dialog.showMessageBox(window, {
              type: "error",
              message: "无法完成更新",
              detail: error instanceof Error ? error.message : String(error),
              ...(!downloading && {
                buttons: ["打开发布页", "关闭"],
                defaultId: 1,
                cancelId: 1,
              }),
            });
            if (!downloading && selected.response === 0 && alive()) {
              try {
                await shell.openExternal(
                  "https://github.com/cynicalight/reader/releases/latest",
                );
              } catch {
                if (alive())
                  await dialog.showMessageBox(window, {
                    type: "error",
                    message: "无法打开发布页",
                    detail:
                      "请在浏览器中访问 https://github.com/cynicalight/reader/releases/latest",
                  });
              }
            }
          } else
            console.warn(
              "Reader update:",
              error instanceof Error ? error.message : String(error),
            );
        }
      }
    })().finally(() => {
      report(null);
      active = undefined;
    });
    return active;
  };
  const initial = setTimeout(() => {
    void check();
  }, 15_000);
  const timer = setInterval(() => {
    void check();
  }, 60_000);
  initial.unref();
  timer.unref();
  return {
    check: () => check(true),
    stop: () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
    },
  };
}
