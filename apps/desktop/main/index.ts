import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  nativeTheme,
  shell,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readFile, realpath, lstat } from "node:fs/promises";
import {
  libraryDirectory,
  migrateLibrary,
  stopLibraryServer,
} from "./library-location";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { agentPath } from "./agent-path";
import { codexThreadURL } from "../../../packages/reader-core/src/codex-link";
import { annotationUndoShortcut } from "../../../packages/reader-core/src/undo-shortcut";
import { zoomCommand } from "../../../packages/reader-core/src/zoom-shortcut";
import { documentTabCommand } from "../../../packages/reader-core/src/document-tab-shortcut";
import {
  READER_SCHEME,
  parseReaderLink,
  type ReaderLinkTarget,
} from "../../../packages/reader-core/src/reader-link";
import { writeClipboardImage, writeClipboardText } from "./clipboard";
import {
  ProxySettingsService,
  electronProxyConfiguration,
} from "./proxy-settings";
import { startUpdateService } from "./update-service";
import { devIsolation } from "./dev-isolation";
import { startDiagnosticService } from "./diagnostic-service";
import { serverSpawnDiagnostics } from "./server-spawn-diagnostics";
import { discoverEndNote } from "./endnote-discovery";
import { commandLineStatus, setCommandLine } from "./command-line";
const isolation = devIsolation({
  isPackaged: app.isPackaged,
  env: process.env,
});
if (isolation.userDataDirectory)
  app.setPath(
    "userData",
    join(app.getPath("appData"), isolation.userDataDirectory),
  );
let updateService: Awaited<ReturnType<typeof startUpdateService>> | undefined;
let diagnostics: ReturnType<typeof startDiagnosticService> | undefined;
let child: ChildProcess | undefined;
let serverURL = "";
let serverToken = "";
let window: BrowserWindow | undefined;
let documentTabActive = false;
let quitting = false;
let closing = false;
let flushed = false;
let restartRequested = false;
let proxySettings: ProxySettingsService;
let activeLibrary: string | undefined;
let choosingLibrary = false;
let pendingLibraryMove:
  { destination: string; resolve: (moved: boolean) => void } | undefined;
const root = resolve(__dirname, "../..");
function bundledBinary(name: "reader-server" | "reader") {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return app.isPackaged
    ? join(process.resourcesPath, "bin", file)
    : join(root, "desktop", "bin", file);
}
function serverBinary() {
  return bundledBinary("reader-server");
}
const commandLineHost = () => ({
  platform: process.platform,
  packaged: app.isPackaged,
  binary: bundledBinary("reader"),
  env: process.env,
});
async function startServer() {
  const childEnv = proxySettings.activeEnvironment;
  serverToken = randomBytes(32).toString("hex");
  diagnostics?.logs.secrets.push(serverToken);
  diagnostics?.record("server.start_requested");
  const binary = serverBinary();
  const web = app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(root, "web", "dist");
  const pathValue = await agentPath(childEnv, homedir(), process.platform);
  child = spawn(
    binary,
    [
      "--port",
      "0",
      "--logs",
      diagnostics!.directory,
      "--session",
      diagnostics!.logs.sessionId,
      "--data",
      activeLibrary!,
      "--shutdown-on-stdin",
      "--web",
      web,
      ...(!isolation.enableConnector ? ["--connector=false"] : []),
    ],
    {
      env: {
        ...childEnv,
        READER_TOKEN: serverToken,
        PATH: pathValue,
        READER_NODE: process.execPath,
        READER_AGENT: app.isPackaged
          ? join(process.resourcesPath, "agent", "dist", "main.mjs")
          : join(root, "agent", "dist", "main.mjs"),
        READER_PROCESSOR: app.isPackaged
          ? join(process.resourcesPath, "processor", "main.mjs")
          : join(root, "processor", "dist", "main.mjs"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stderrLines = createInterface({ input: child.stderr! });
  stderrLines.on("line", (line) =>
    diagnostics?.logs.record("server-stderr", {
      level: "error",
      event: "server.stderr",
      detail: line.slice(0, 16000),
    }),
  );
  child.once("close", () => stderrLines.close());
  return new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => {
      child?.kill();
      reject(new Error("本地服务启动超时"));
    }, 20000);
    child!.once("error", (err) => {
      diagnostics?.logs.record("desktop", {
        level: "error",
        event: "server.spawn_failed",
        ...serverSpawnDiagnostics(binary, err),
      });
      clearTimeout(timer);
      reject(err);
    });
    child!.once("exit", (code) => {
      diagnostics?.logs.record("desktop", {
        level: quitting ? "info" : "error",
        event: "server.exited",
        exitCode: code,
      });
      clearTimeout(timer);
      reject(new Error(`本地服务已退出 (${code})`));
      if (window && !quitting) {
        void diagnostics!
          .failure(
            "Reader 本地服务已停止",
            "已保存的文档和笔记仍保留在本地。可先导出诊断包，再重新打开 Reader。",
          )
          .then(() => {
            flushed = true;
            app.quit();
          });
      }
    });
    const lines = createInterface({ input: child!.stdout! });
    lines.once("line", (line) => {
      try {
        const ready = JSON.parse(line);
        serverURL = ready.url;
        diagnostics?.record("server.ready");
        clearTimeout(timer);
        lines.close();
        accept(serverURL);
      } catch {
        clearTimeout(timer);
        reject(new Error("本地服务返回了无效启动信息"));
      }
    });
  });
}
/** Window background before the renderer paints, matching the theme. */
function windowBackground(appearance: unknown, palettes: unknown) {
  const option = (key: string) =>
    typeof palettes === "object" && palettes !== null && key in palettes
      ? (palettes as Record<string, unknown>)[key]
      : undefined;
  const system = appearance !== "light" && appearance !== "sepia";
  const dark =
    appearance === "dark" || (system && nativeTheme.shouldUseDarkColors);
  if (!dark)
    return appearance === "sepia" ||
      (system && option("systemLightMode") === "sepia")
      ? "#eeede7"
      : "#ffffff";
  // Pure black keeps the neutral dark window; graphite is the default.
  const contrast = option(
    appearance === "dark" ? "pdfDarkContrast" : "systemDarkContrast",
  );
  return contrast === "high" ? "#171717" : "#211e21";
}
// Long papers wait for the reader's choice. The renderer refers to them by
// one-time IDs, never by path.
const largePapers = new Map<string, string>();
async function importPaths(
  paths: string[],
  library: "books" | "papers" = "books",
  allowLarge = false,
  folder = "",
) {
  const accepted = library === "papers" ? /\.pdf$/i : /\.(epub|pdf)$/i;
  const large: Array<{ id: string; name: string; pages: number }> = [];
  for (const path of paths) {
    if (!accepted.test(path)) continue;
    const data = await readFile(path);
    const name = path.split(/[\\/]/).pop()!;
    const form = new FormData();
    form.append("library", library);
    if (allowLarge) form.append("allowLarge", "1");
    if (folder.startsWith("smart:"))
      form.append("smartCategory", folder.slice(6));
    else if (folder)
      form.append(
        "folder",
        folder.startsWith("folder:") ? folder.slice(7) : folder,
      );
    form.append("file", new Blob([data]), name);
    const response = await fetch(`${serverURL}/api/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serverToken}` },
      body: form,
    });
    if (!response.ok) {
      const failure = await response.json();
      if (failure.code !== "large-paper") throw new Error(failure.error);
      const id = randomBytes(16).toString("hex");
      largePapers.set(id, path);
      large.push({ id, name, pages: failure.pages });
    }
  }
  window?.webContents.send("reader:library-changed");
  return large;
}
// reader:// links reach one window. The renderer claims queued links once its
// listener exists; later links are sent directly.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
const pendingLinks: ReaderLinkTarget[] = [];
let linksClaimed = false;
function openLink(link: string) {
  const target = parseReaderLink(link);
  if (!target) return;
  if (linksClaimed && window && !window.isDestroyed()) {
    window.webContents.send("reader:open-link", target);
    if (window.isMinimized()) window.restore();
    window.focus();
  } else pendingLinks.push(target);
}
const linkArgument = (argv: string[]) =>
  argv.find((arg) => arg.toLowerCase().startsWith(`${READER_SCHEME}://`));
app.on("open-url", (event, link) => {
  event.preventDefault();
  openLink(link);
});
app.on("second-instance", (_event, argv) => {
  const link = linkArgument(argv);
  if (link) openLink(link);
  else if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
{
  const link = linkArgument(process.argv);
  if (link) openLink(link);
}
const pendingFiles: string[] = [];
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (serverURL)
    void importPaths([path]).catch((e) =>
      dialog.showErrorBox("导入失败", e.message),
    );
  else pendingFiles.push(path);
});
app
  .whenReady()
  .then(async () => {
    if (!primary) return;
    diagnostics = startDiagnosticService(
      () => window,
      () => activeLibrary,
    );
    ipcMain.on("reader:diagnostic-event", (event, value) =>
      diagnostics!.receive(event, value),
    );
    ipcMain.on("reader:diagnostic-settings", (event, value) =>
      diagnostics!.receiveSettings(event, value),
    );
    ipcMain.handle("reader:export-diagnostics", (event) =>
      diagnostics!.invoke(event),
    );
    // Development runs need the entry script registered beside Electron.
    if (isolation.registerProtocol) {
      if (process.defaultApp && process.argv.length >= 2)
        app.setAsDefaultProtocolClient(READER_SCHEME, process.execPath, [
          resolve(process.argv[1]),
        ]);
      else app.setAsDefaultProtocolClient(READER_SCHEME);
    }
    proxySettings = await ProxySettingsService.open(
      app.getPath("userData"),
      process.env,
    );
    await session.defaultSession.setProxy(
      electronProxyConfiguration(proxySettings.activeSettings),
    );
    activeLibrary = await libraryDirectory(app.getPath("userData"));
    const url = await startServer();
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        // Only Reader's own page may list installed fonts, for the
        // translation font picker; every other request stays denied.
        let origin = "";
        try {
          origin = new URL(details.requestingUrl).origin;
        } catch {
          /* not a URL */
        }
        callback(
          permission === "local-fonts" &&
            contents === window?.webContents &&
            origin === new URL(url).origin,
        );
      },
    );
    const preferences: unknown = await fetch(`${url}/api/settings`, {
      headers: { Authorization: `Bearer ${serverToken}` },
    })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    diagnostics.setSettings(preferences);
    const appearance =
      typeof preferences === "object" &&
      preferences !== null &&
      "appearance" in preferences
        ? preferences.appearance
        : undefined;
    nativeTheme.themeSource =
      appearance === "light" || appearance === "dark"
        ? appearance
        : appearance === "sepia"
          ? "light"
          : "system";
    window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1000,
      minHeight: 660,
      title: "Reader",
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hidden" as const,
            trafficLightPosition: { x: 20, y: 20 },
          }
        : { autoHideMenuBar: true }),
      backgroundColor: windowBackground(appearance, preferences),
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      diagnostics!.logs.record("desktop", {
        level: "error",
        event: "renderer.exited",
        reason: details.reason,
        exitCode: details.exitCode,
      });
      if (!quitting)
        void diagnostics!
          .failure("Reader 界面已停止", "可先导出诊断包，再重新打开 Reader。")
          .then(() => {
            flushed = true;
            app.quit();
          });
    });
    window.webContents.on("did-fail-load", (_event, code) =>
      diagnostics?.logs.record("desktop", {
        level: "error",
        event: "renderer.load_failed",
        code,
      }),
    );
    window.on("close", (event) => {
      if (flushed) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      window!.webContents.send("reader:flush");
      const timer = setTimeout(() => {
        void finish("保存超时，请重试。");
      }, 10000);
      const handler = (event: Electron.IpcMainEvent, error: string | null) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          return;
        void finish(error);
      };
      let finished = false;
      const finish = async (error: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ipcMain.removeListener("reader:flushed", handler);
        if (error) {
          // A failed flush must never produce a migrated, stale snapshot.
          pendingLibraryMove?.resolve(false);
          pendingLibraryMove = undefined;
          diagnostics?.record("reading.flush_failed", new Error(error));
          const result = await dialog.showMessageBox(window!, {
            type: "warning",
            message: "阅读数据尚未保存",
            detail: error,
            buttons: ["返回阅读", "仍然退出"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response === 0) {
            closing = false;
            restartRequested = false;
            return;
          }
        }
        if (pendingLibraryMove) {
          const move = pendingLibraryMove;
          pendingLibraryMove = undefined;
          quitting = true; // This server exit is intentional.
          updateService?.stop();
          proxySettings?.stop();
          try {
            await migrateLibrary(
              app.getPath("userData"),
              activeLibrary!,
              move.destination,
              serverBinary(),
              async () => {
                if (child) await stopLibraryServer(child);
              },
            );
            move.resolve(true);
          } catch (error) {
            await dialog.showMessageBox(window!, {
              type: "error",
              message: "书库迁移失败",
              detail: `${(error as Error).message}\n原书库已保留，将重新打开原来的位置。`,
              buttons: ["重新打开 Reader"],
            });
            move.resolve(false);
          }
        }
        flushed = true;
        window?.close();
      };
      ipcMain.on("reader:flushed", handler);
    });
    // Let the renderer handle reading shortcuts; editable fields keep native undo.
    window.webContents.on("before-input-event", (_event, input) => {
      const tabCommand = documentTabCommand({
        key: input.key,
        metaKey: input.meta,
        ctrlKey: input.control,
        shiftKey: input.shift,
        altKey: input.alt,
        isComposing: input.isComposing,
      });
      window?.webContents.setIgnoreMenuShortcuts(
        input.type === "keyDown" &&
          ((tabCommand !== null &&
            (documentTabActive || tabCommand.type === "reopen")) ||
            annotationUndoShortcut({
              key: input.key,
              metaKey: input.meta,
              ctrlKey: input.control,
              shiftKey: input.shift,
              altKey: input.alt,
              isComposing: input.isComposing,
            }) ||
            ((input.meta || input.control) &&
              !input.shift &&
              !input.alt &&
              input.key.toLowerCase() === "f") ||
            zoomCommand({
              key: input.key,
              code: input.code,
              metaKey: input.meta,
              ctrlKey: input.control,
              altKey: input.alt,
              isComposing: input.isComposing,
            }) !== null),
      );
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== url) event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    ipcMain.handle("reader:clipboard-write", (event, text: unknown) =>
      writeClipboardText(event, text, window?.webContents, url),
    );
    ipcMain.handle(
      "reader:clipboard-write-image",
      (event, data: unknown, text: unknown) =>
        writeClipboardImage(event, data, text, window?.webContents, url),
    );
    const settingsSender = (event: Electron.IpcMainInvokeEvent) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== url
      )
        throw new Error("Invalid sender");
    };
    ipcMain.handle("reader:library-location", (event) => {
      settingsSender(event);
      return activeLibrary;
    });
    ipcMain.handle("reader:document-tab-active", (event, active: unknown) => {
      settingsSender(event);
      if (typeof active !== "boolean") throw new Error("Invalid tab state");
      documentTabActive = active;
    });
    ipcMain.handle("reader:move-library", async (event) => {
      settingsSender(event);
      if (choosingLibrary || closing || restartRequested) return false;
      choosingLibrary = true;
      try {
        const selected = await dialog.showOpenDialog(window!, {
          title: "选择书库保存位置（将在其中新建 Reader Library）",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return false;
        const destination = join(
          await realpath(selected.filePaths[0]),
          "Reader Library",
        );
        // The server's SQLite DSN treats ? as the start of query parameters.
        if (destination.includes("?"))
          throw new Error("书库路径不能包含 ?，请选择其他位置。");
        try {
          await lstat(destination);
          throw new Error(
            "所选位置已有 Reader Library 文件夹，请选择其他位置。",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const confirmed = await dialog.showMessageBox(window!, {
          type: "question",
          message: "迁移书库并重启 Reader？",
          detail: `新位置：${destination}\nPDF、笔记、批注和阅读记录将一起复制。原书库保留。`,
          buttons: ["迁移并重启", "取消"],
          defaultId: 0,
          cancelId: 1,
        });
        if (confirmed.response !== 0 || closing || quitting) return false;
        return await new Promise<boolean>((resolve) => {
          pendingLibraryMove = { destination, resolve };
          restartRequested = true;
          app.quit();
        });
      } finally {
        choosingLibrary = false;
      }
    });
    ipcMain.handle("reader:proxy-settings", (event) => {
      settingsSender(event);
      return proxySettings.state();
    });
    ipcMain.handle("reader:save-proxy-settings", (event, value: unknown) => {
      settingsSender(event);
      return proxySettings.save(value);
    });
    ipcMain.handle("reader:check-proxy", (event, value: unknown) => {
      settingsSender(event);
      return proxySettings.check(value, serverBinary());
    });
    ipcMain.handle("reader:command-line", (event) => {
      settingsSender(event);
      return commandLineStatus(commandLineHost());
    });
    ipcMain.handle("reader:set-command-line", (event, installed: unknown) => {
      settingsSender(event);
      if (typeof installed !== "boolean") throw new Error("Invalid request");
      return setCommandLine(commandLineHost(), installed);
    });
    ipcMain.handle("reader:restart", (event) => {
      settingsSender(event);
      if (closing || restartRequested) return;
      restartRequested = true;
      app.quit();
    });
    ipcMain.handle(
      "reader:appearance",
      (event, appearance: unknown, palettes: unknown) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        if (
          appearance !== "light" &&
          appearance !== "sepia" &&
          appearance !== "dark" &&
          appearance !== "system"
        )
          throw new Error("Invalid appearance");
        // Paper is a light theme for native chrome with its own background.
        nativeTheme.themeSource = appearance === "sepia" ? "light" : appearance;
        window.setBackgroundColor(windowBackground(appearance, palettes));
      },
    );
    ipcMain.handle(
      "reader:document-file",
      async (event, id: unknown, type: unknown, action: unknown) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        // Only library-owned copies, addressed by content hash, can be reached.
        if (
          typeof id !== "string" ||
          !/^[0-9a-f]{32}$/.test(id) ||
          (type !== "pdf" && type !== "epub") ||
          (action !== "show" && action !== "open")
        )
          throw new Error("Invalid document");
        const file = join(
          activeLibrary!,
          type === "pdf" ? "papers" : "books",
          `${id}.${type}`,
        );
        if (action === "show") shell.showItemInFolder(file);
        else {
          const error = await shell.openPath(file);
          if (error) throw new Error(error);
        }
      },
    );
    ipcMain.handle("reader:take-links", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      linksClaimed = true;
      return pendingLinks.splice(0);
    });
    ipcMain.handle(
      "reader:open-codex-thread",
      async (event, threadId: unknown) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        await shell.openExternal(codexThreadURL(threadId));
      },
    );
    ipcMain.handle("reader:open-external", async (event, url: unknown) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      if (typeof url !== "string" || !/^https?:\/\//i.test(url))
        throw new Error("Invalid link");
      await shell.openExternal(new URL(url).toString());
    });
    let endnoteSearch: { id: string; controller: AbortController } | undefined;
    const checkEndnoteSender = (event: Electron.IpcMainInvokeEvent) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
    };
    ipcMain.handle("reader:find-endnote", async (event, id: unknown) => {
      checkEndnoteSender(event);
      if (typeof id !== "string" || id.length > 100)
        throw new Error("Invalid search");
      endnoteSearch?.controller.abort();
      const search = { id, controller: new AbortController() };
      endnoteSearch = search;
      const roots = [
        app.getPath("documents"),
        app.getPath("desktop"),
        app.getPath("downloads"),
        join(homedir(), "Developer"),
      ];
      if (process.env.OneDrive)
        roots.push(join(process.env.OneDrive, "Documents"));
      try {
        return await discoverEndNote(
          roots,
          process.platform,
          search.controller.signal,
        );
      } finally {
        if (endnoteSearch === search) endnoteSearch = undefined;
      }
    });
    ipcMain.handle("reader:cancel-endnote-search", (event, id: unknown) => {
      checkEndnoteSender(event);
      if (endnoteSearch && endnoteSearch.id === id)
        endnoteSearch.controller.abort();
    });
    ipcMain.handle(
      "reader:choose-endnote",
      async (event, directory: unknown) => {
        checkEndnoteSender(event);
        const selected = await dialog.showOpenDialog(window!, {
          title: directory
            ? "选择 EndNote 文献库所在目录"
            : "选择 EndNote 文献库",
          properties: directory ? ["openDirectory"] : ["openFile"],
          ...(!directory
            ? {
                filters: [
                  { name: "EndNote 文献库", extensions: ["enl", "enlp"] },
                ],
              }
            : {}),
        });
        return selected.canceled ? null : selected.filePaths[0] || null;
      },
    );
    ipcMain.handle("reader:choose-zotero-directory", async (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      const selected = await dialog.showOpenDialog(window, {
        title: "选择 Zotero 目录",
        properties: ["openDirectory"],
      });
      return selected.canceled ? null : selected.filePaths[0] || null;
    });
    ipcMain.handle(
      "reader:import",
      async (event, library: unknown, folder: unknown) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        if (library !== "books" && library !== "papers")
          throw new Error("Invalid library");
        if (typeof folder !== "string" || (library !== "papers" && folder))
          throw new Error("Invalid folder");
        const selected = await dialog.showOpenDialog(window, {
          properties: ["openFile", "multiSelections"],
          filters:
            library === "papers"
              ? [{ name: "PDF", extensions: ["pdf"] }]
              : [{ name: "EPUB / PDF", extensions: ["epub", "pdf"] }],
        });
        return selected.canceled
          ? []
          : importPaths(selected.filePaths, library, false, folder);
      },
    );
    ipcMain.handle(
      "reader:import-large",
      async (event, ids: unknown, library: unknown, folder: unknown) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        if (
          !Array.isArray(ids) ||
          (library !== "books" && library !== "papers") ||
          typeof folder !== "string" ||
          (library !== "papers" && folder)
        )
          throw new Error("Invalid import");
        const paths = ids.flatMap((id) => {
          const path = typeof id === "string" ? largePapers.get(id) : undefined;
          if (path) largePapers.delete(id);
          return path ? [path] : [];
        });
        await importPaths(paths, library, true, folder);
      },
    );
    await window.loadURL(`${url}/#token=${serverToken}`);
    if (pendingFiles.length) await importPaths(pendingFiles.splice(0));
    updateService = await startUpdateService(window);
    ipcMain.handle("reader:check-updates", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      return updateService?.check();
    });
  })
  .catch(async (error) => {
    diagnostics?.record("desktop.start_failed", error);
    if (diagnostics)
      await diagnostics.failure(
        "无法打开 Reader",
        "可导出启动日志供开发者排查，然后退出重试。",
      );
    else dialog.showErrorBox("无法打开 Reader", String(error));
    flushed = true;
    app.quit();
  });
app.on("before-quit", (event) => {
  if (window && !window.isDestroyed() && !flushed) {
    event.preventDefault();
    window.close();
    return;
  }
  quitting = true;
  if (restartRequested) {
    restartRequested = false;
    app.relaunch();
  }
  diagnostics?.record("desktop.stopping");
  updateService?.stop();
  proxySettings?.stop();
  child?.kill();
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => app.quit());
app.on("window-all-closed", () => app.quit());
