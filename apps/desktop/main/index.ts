import { renderMarkdownPDF, cancelMarkdownPDF } from "./markdown-pdf";
import { confirmReaderMigration } from "./migration-confirmation";
import { startupAppearanceArgument } from "../startup-appearance";
import { saveStartupAppearance } from "./startup-appearance-cache";
import {
  app,
  autoUpdater,
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
  saveLibraryDirectory,
  validateLibraryDirectory,
} from "./library-location";
import { startLibraryRecoveryServer } from "./library-recovery-server";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { createStartupWindow } from "./startup-window";
import { prepareStartupExit } from "./startup-exit";
import { agentPath } from "./agent-path";
import { codexThreadURL } from "../../../packages/neoread-core/src/codex-link";
import { annotationUndoShortcut } from "../../../packages/neoread-core/src/undo-shortcut";
import { zoomCommand } from "../../../packages/neoread-core/src/zoom-shortcut";
import { documentTabCommand } from "../../../packages/neoread-core/src/document-tab-shortcut";
import {
  LINK_SCHEMES,
  parseNeoReadLink,
  type NeoReadLinkTarget,
} from "../../../packages/neoread-core/src/neoread-link";
import { writeClipboardImage, writeClipboardText } from "./clipboard";
import {
  ProxySettingsService,
  electronProxyConfiguration,
} from "./proxy-settings";
import { startUpdateService } from "./update-service";
import { devIsolation } from "./dev-isolation";
import { documentArguments, documentFile } from "./open-files";
import {
  migrateReaderData,
  detectReaderMigration,
  declineReaderMigration,
  ReaderMigrationError,
  promptLegacyCleanup,
  type ReaderMigration,
} from "./legacy-data";
import { startDiagnosticService } from "./diagnostic-service";
import { serverSpawnDiagnostics } from "./server-spawn-diagnostics";
import { discoverEndNote } from "./endnote-discovery";
import { commandLineStatus, setCommandLine } from "./command-line";
import { startCitationService } from "./citation-service";
import {
  citePluginStatus,
  authorizeWordPluginAccess,
  wordAccessFolder,
  installCitePlugin,
  uninstallCitePlugin,
  type CitePluginKind,
} from "./cite-plugins";
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
const migrationController = new AbortController();
let pendingReaderMigration: Promise<ReaderMigration> | undefined;
let child: ChildProcess | undefined;
let serverURL = "";
let serverToken = "";
let window: BrowserWindow | undefined;
let startupWindow: ReturnType<typeof createStartupWindow> | undefined;
let startupStarted = performance.now();
let bootstrapEntryMs: number | undefined;
export function adoptStartupWindow(
  startup: ReturnType<typeof createStartupWindow>,
  startedAt: number,
  entryMs: number,
) {
  startupWindow = startup;
  startupStarted = startedAt;
  bootstrapEntryMs = entryMs;
}
function startupStage(event: string, started = startupStarted) {
  diagnostics?.logs.record("desktop", {
    level: "info",
    event,
    durationMs: Math.round(performance.now() - started),
  });
}
let documentTabActive = false;
let citationService: ReturnType<typeof startCitationService> | undefined;
let reopenMainWindow: (() => Promise<void>) | undefined;
let mainWindowOpening: Promise<void> | undefined;
let quitRequested = false;
function showMainWindow() {
  if (quitRequested || quitting) return;
  if (startupWindow) {
    const feedback = startupWindow.nativeWindow;
    if (feedback && !feedback.isDestroyed()) {
      if (feedback.isMinimized()) feedback.restore();
      feedback.show();
      feedback.focus();
    }
    return;
  }
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else if (reopenMainWindow && !mainWindowOpening) {
    mainWindowOpening = reopenMainWindow()
      .catch((error) => {
        diagnostics?.record("desktop.reopen_failed", error);
        dialog.showErrorBox("无法重新打开 NeoRead", "请退出 NeoRead 后重试。");
      })
      .finally(() => {
        mainWindowOpening = undefined;
      });
  }
}
app.on("activate", showMainWindow);
// Updating closes windows before app's before-quit event.
autoUpdater.on("before-quit-for-update", () => {
  quitRequested = true;
});
let quitting = false;
let closing = false;
let flushed = false;
let restartRequested = false;
let proxyReady: Promise<ProxySettingsService>;
const runtimeController = new AbortController();
let proxySettings: ProxySettingsService;
let activeLibrary: string | undefined;
let choosingLibrary = false;
let libraryWarning = "";
let recoveryServer:
  Awaited<ReturnType<typeof startLibraryRecoveryServer>> | undefined;
let pendingLibraryMove:
  | {
      destination: string;
      existing?: boolean;
      resolve: (moved: boolean) => void;
    }
  | undefined;
const root = resolve(__dirname, "../..");
/** Word template and WPS add-in files (apps/cite-plugins in development). */
const citePluginsDirectory = () =>
  app.isPackaged
    ? join(process.resourcesPath, "cite-plugins")
    : join(root, "cite-plugins");
function bundledBinary(name: "neoread-server" | "neoread") {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return app.isPackaged
    ? join(process.resourcesPath, "bin", file)
    : join(root, "desktop", "bin", file);
}
function serverBinary() {
  return bundledBinary("neoread-server");
}
const commandLineHost = () => ({
  platform: process.platform,
  packaged: app.isPackaged,
  binary: bundledBinary("neoread"),
  env: process.env,
});
async function startServer() {
  const childEnv = process.env;
  serverToken = randomBytes(32).toString("hex");
  diagnostics?.logs.secrets.push(serverToken);
  diagnostics?.record("server.start_requested");
  const binary = serverBinary();
  const web = app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(root, "web", "dist");
  const citePlugins = citePluginsDirectory();
  if (quitting) throw new Error("Startup cancelled");
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
      "--desktop-runtime",
      "--web",
      web,
      "--cite-plugins",
      citePlugins,
      ...(!isolation.enableConnector ? ["--connector=false"] : []),
    ],
    {
      env: {
        ...childEnv,
        NEOREAD_TOKEN: serverToken,
        NEOREAD_NODE: process.execPath,
        NEOREAD_AGENT: app.isPackaged
          ? join(process.resourcesPath, "agent", "dist", "main.mjs")
          : join(root, "agent", "dist", "main.mjs"),
        NEOREAD_PROCESSOR: app.isPackaged
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
    let started = false;
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
      // Startup failures are handled by the outer startup catch. Once ready,
      // the service remains essential even with no main window on macOS.
      if (started && !quitting) {
        quitRequested = true;
        flushed = true;
        citationService?.stop();
        citationService = undefined;
        void diagnostics!
          .failure(
            "NeoRead 本地服务已停止",
            "已保存的文档和笔记仍保留在本地。可先导出诊断包，再重新打开 NeoRead。",
          )
          .catch(() => {})
          .finally(() => {
            app.quit();
          });
      }
    });
    const lines = createInterface({ input: child!.stdout! });
    lines.once("line", (line) => {
      try {
        const ready = JSON.parse(line);
        serverURL = ready.url;
        started = true;
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
  const accepted = library === "papers" ? /\.pdf$/i : documentFile;
  const large: Array<{ id: string; name: string; pages: number }> = [];
  const documents: string[] = [];
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
    } else documents.push((await response.json()).id);
  }
  window?.webContents.send("neoread:library-changed");
  return { large, documents };
}
// neoread:// links reach one window. The renderer claims queued links once its
// listener exists; later links are sent directly.
const primary =
  app.hasSingleInstanceLock?.() || app.requestSingleInstanceLock();
if (!primary) app.quit();
const pendingLinks: NeoReadLinkTarget[] = [];
let linksClaimed = false;
function openLink(link: string) {
  const target = parseNeoReadLink(link);
  if (!target) return;
  if (linksClaimed && window && !window.isDestroyed()) {
    window.webContents.send("neoread:open-link", target);
    showMainWindow();
  } else {
    pendingLinks.push(target);
    showMainWindow();
  }
}
const linkArgument = (argv: string[]) =>
  argv.find((arg) =>
    LINK_SCHEMES.some((scheme) => arg.toLowerCase().startsWith(`${scheme}://`)),
  );
app.on("open-url", (event, link) => {
  event.preventDefault();
  openLink(link);
});
app.on("second-instance", (_event, argv, workingDirectory) => {
  const link = linkArgument(argv);
  const files =
    process.platform === "darwin"
      ? []
      : documentArguments(argv, workingDirectory, !!process.defaultApp);
  if (link) openLink(link);
  else {
    openFiles(files);
    // Windows lets the window come forward only while handling this event.
    showMainWindow();
  }
});
{
  const link = linkArgument(process.argv);
  if (link) openLink(link);
}
// Documents opened from Finder or Explorer are imported like any other file:
// PDFs into papers, where long ones wait for the reader's choice, and EPUBs
// into books. An identical file resolves to the existing document. The
// renderer opens the first of each batch once it may be read.
type OpenedFiles = {
  documents: string[];
  large: Array<{ id: string; name: string; pages: number }>;
};
const pendingFiles: string[] = [];
const pendingOpened: OpenedFiles[] = [];
let openedClaimed = false;
let filesScheduled: NodeJS.Timeout | undefined;
function openFiles(paths: string[]) {
  if (!paths.length) return;
  pendingFiles.push(...paths);
  // Finder delivers a multiple selection as separate open-file events.
  if (serverURL && !recoveryServer && !filesScheduled)
    filesScheduled = setTimeout(() => void flushFiles(), 100);
}
async function flushFiles() {
  filesScheduled = undefined;
  const paths = pendingFiles.splice(0);
  if (!paths.length) return;
  const opened: OpenedFiles = { documents: [], large: [] };
  try {
    for (const path of paths) {
      const { documents, large } = await importPaths(
        [path],
        /\.pdf$/i.test(path) ? "papers" : "books",
      );
      opened.documents.push(...documents);
      opened.large.push(...large);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    diagnostics?.logs.record("desktop", {
      level: "error",
      event: "open_with.import_failed",
      count: paths.length,
      errorCode: ["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(code || "")
        ? code
        : "import",
    });
    dialog.showErrorBox("导入失败", (error as Error).message);
  }
  if (!opened.documents.length && !opened.large.length) return;
  if (openedClaimed && window && !window.isDestroyed()) {
    window.webContents.send("neoread:open-files", opened);
    showMainWindow();
  } else {
    pendingOpened.push(opened);
    showMainWindow();
  }
}
app.on("open-file", (event, path) => {
  event.preventDefault();
  openFiles([path]);
});
if (process.platform !== "darwin")
  openFiles(
    documentArguments(process.argv, process.cwd(), !!process.defaultApp),
  );
app
  .whenReady()
  .then(async () => {
    if (!primary) return;
    diagnostics = startDiagnosticService(
      () => window,
      () => activeLibrary,
      app.isPackaged,
    );
    startupWindow ??= createStartupWindow(() => app.quit());
    await startupWindow.load();
    if (bootstrapEntryMs !== undefined)
      diagnostics.logs.record("desktop", {
        level: "info",
        event: "startup.bootstrap_entry",
        durationMs: bootstrapEntryMs,
      });
    startupStage("startup.loading_visible");
    if (quitting) return;
    let migration: ReaderMigration | undefined;
    if (app.isPackaged) {
      const detection = await detectReaderMigration(
        app.getPath("appData"),
        app.getPath("userData"),
      );
      diagnostics.logs.record("desktop", {
        level: "info",
        event: "migration.detected",
        status: detection,
      });
      if (quitting) return;
      let shouldMigrate = detection === "none";
      if (detection === "required" || detection === "resume") {
        const confirmed = await confirmReaderMigration(
          join(process.resourcesPath, "web"),
          join(__dirname, "migration-preload.cjs"),
          detection === "resume",
          migrationController.signal,
          startupWindow.nativeWindow,
        );
        diagnostics.record(
          confirmed ? "migration.confirmed" : "migration.declined",
        );
        if (quitting) return;
        if (!confirmed) {
          try {
            await declineReaderMigration(app.getPath("userData"));
          } catch (error) {
            diagnostics.record("migration.decline_save_failed", error);
          }
        }
        shouldMigrate = confirmed;
      }
      if (shouldMigrate) {
        pendingReaderMigration = migrateReaderData(
          serverBinary(),
          app.getPath("appData"),
          app.getPath("userData"),
          diagnostics,
          migrationController.signal,
        );
        try {
          migration = await pendingReaderMigration;
        } finally {
          pendingReaderMigration = undefined;
        }
      }
    }
    if (quitting) return;
    diagnostics.finishMigration();
    startupStage("startup.migration_ready");
    ipcMain.on("neoread:diagnostic-event", (event, value) =>
      diagnostics!.receive(event, value),
    );
    ipcMain.on("neoread:diagnostic-settings", (event, value) =>
      diagnostics!.receiveSettings(event, value),
    );
    ipcMain.handle("neoread:export-diagnostics", (event) =>
      diagnostics!.invoke(event),
    );
    // Development runs need the entry script registered beside Electron.
    if (isolation.registerProtocol) {
      for (const scheme of LINK_SCHEMES)
        if (process.defaultApp && process.argv.length >= 2)
          app.setAsDefaultProtocolClient(scheme, process.execPath, [
            resolve(process.argv[1]),
          ]);
        else app.setAsDefaultProtocolClient(scheme);
    }
    const proxyStarted = performance.now();
    proxyReady = ProxySettingsService.open(
      app.getPath("userData"),
      process.env,
    ).then(async (service) => {
      proxySettings = service;
      if (quitting) {
        service.stop();
        return service;
      }
      await session.defaultSession.setProxy(
        electronProxyConfiguration(service.activeSettings),
      );
      startupStage("startup.proxy_ready", proxyStarted);
      return service;
    });
    // Start both discoveries together; neither is a prerequisite for Go.
    const pathStarted = performance.now();
    const pathReady = agentPath(process.env, homedir(), process.platform).then(
      (value) => {
        startupStage("startup.agent_path_ready", pathStarted);
        return value;
      },
    );
    // Observe errors immediately while library initialization proceeds.
    void proxyReady.catch((error) =>
      diagnostics?.record("startup.proxy_failed", error),
    );
    void pathReady.catch((error) =>
      diagnostics?.record("startup.agent_path_failed", error),
    );
    try {
      activeLibrary = await libraryDirectory(app.getPath("userData"));
    } catch (error) {
      libraryWarning = (error as Error).message;
      diagnostics.logs.record("desktop", {
        level: "warn",
        event: "library.unavailable",
        detail: libraryWarning,
      });
      recoveryServer = await startLibraryRecoveryServer(
        app.isPackaged
          ? join(process.resourcesPath, "web")
          : join(root, "web", "dist"),
      );
    }
    if (quitting) return;
    const url = recoveryServer
      ? (serverURL = recoveryServer.url)
      : await startServer();
    if (quitting) return;
    startupStage("startup.server_ready");
    if (!recoveryServer) {
      const sendRuntime = async (
        stage: string,
        value: Record<string, string | null>,
      ) => {
        if (quitting) return;
        const response = await fetch(`${url}/api/desktop-runtime/${stage}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serverToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(value),
          signal: AbortSignal.any([
            runtimeController.signal,
            AbortSignal.timeout(5000),
          ]),
        });
        if (!response.ok) throw new Error("无法传递启动环境");
      };
      void proxyReady
        .then((service) =>
          sendRuntime(
            "network",
            Object.fromEntries(
              [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
                "no_proxy",
              ].map((key) => [key, service.activeEnvironment[key] ?? null]),
            ),
          ),
        )
        .catch((error) => {
          if (!quitting)
            diagnostics?.record("startup.network_delivery_failed", error);
        });
      void pathReady
        .then((value) => sendRuntime("path", { PATH: value }))
        .catch((error) => {
          if (!quitting)
            diagnostics?.record("startup.path_delivery_failed", error);
        });
    }

    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        // Only NeoRead's own page may list installed fonts, for the
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
    reopenMainWindow = async () => {
      if (quitRequested || quitting || (window && !window.isDestroyed()))
        return;
      flushed = false;
      closing = false;
      documentTabActive = false;
      const preferences: unknown = recoveryServer
        ? {}
        : await fetch(
            `${url}/api/settings${startupWindow ? "?startup=1" : ""}`,
            {
              headers: { Authorization: `Bearer ${serverToken}` },
              signal: AbortSignal.timeout(3000),
            },
          ).then((r) => {
            if (!r.ok) throw new Error("无法读取窗口主题设置");
            return r.json();
          });
      if (quitRequested || quitting) return;
      diagnostics!.setSettings(preferences);
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
      startupStage("startup.preferences_ready");
      void saveStartupAppearance(app.getPath("userData"), appearance).catch(
        (error) =>
          diagnostics?.record("startup.appearance_cache_failed", error),
      );
      window = new BrowserWindow({
        show: false,
        width: 1440,
        height: 940,
        minWidth: 1000,
        minHeight: 660,
        title: "NeoRead",
        ...(process.platform === "darwin"
          ? {
              titleBarStyle: "hidden" as const,
              trafficLightPosition: { x: 20, y: 20 },
            }
          : { autoHideMenuBar: true }),
        backgroundColor: windowBackground(appearance, preferences),
        webPreferences: {
          preload: join(__dirname, "preload.cjs"),
          additionalArguments: [startupAppearanceArgument(preferences)],
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
            .failure(
              "NeoRead 界面已停止",
              "可先导出诊断包，再重新打开 NeoRead。",
            )
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
      window.once("closed", () => {
        window = undefined;
        updateService?.stop();
        updateService = undefined;
        linksClaimed = false;
        openedClaimed = false;
      });
      window.on("close", (event) => {
        if (flushed) return;
        event.preventDefault();
        if (closing) return;
        closing = true;
        // Close the visible UI immediately, but keep its renderer and local
        // server alive until the final save acknowledges completion.
        if (!pendingLibraryMove) window!.hide();
        window!.webContents.send("neoread:flush");
        const timer = setTimeout(() => {
          void finish("保存超时，请重试。");
        }, 10000);
        const handler = (
          event: Electron.IpcMainEvent,
          error: string | null,
          noteSaveDiscarded?: boolean,
        ) => {
          if (
            event.sender !== window?.webContents ||
            event.senderFrame !== window.webContents.mainFrame
          )
            return;
          void finish(error, noteSaveDiscarded === true);
        };
        let finished = false;
        const finish = async (
          error: string | null,
          noteSaveDiscarded = false,
        ) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          ipcMain.removeListener("neoread:flushed", handler);
          if (error) {
            // A failed flush must never produce a migrated, stale snapshot.
            pendingLibraryMove?.resolve(false);
            pendingLibraryMove = undefined;
            diagnostics?.record("reading.flush_failed", new Error(error));
            window?.show();
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
              quitRequested = false;
              showMainWindow();
              return;
            }
          }
          if (noteSaveDiscarded) {
            window?.show();
            await dialog.showMessageBox(window!, {
              type: "warning",
              message: "论文笔记保存失败",
              detail: "本次未保存的修改已丢弃。",
              buttons: ["知道了"],
            });
          }
          if (pendingLibraryMove) {
            const move = pendingLibraryMove;
            pendingLibraryMove = undefined;
            quitting = true; // This server exit is intentional.
            updateService?.stop();
            proxySettings?.stop();
            try {
              if (move.existing) {
                if (child) await stopLibraryServer(child);
                await validateLibraryDirectory(
                  move.destination,
                  serverBinary(),
                );
                await saveLibraryDirectory(
                  app.getPath("userData"),
                  move.destination,
                );
              } else
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
                message: move.existing ? "打开书库失败" : "书库迁移失败",
                detail: `${(error as Error).message}\n原书库已保留，将重新打开原来的位置。`,
                buttons: ["重新打开 NeoRead"],
              });
              move.resolve(false);
            }
          }
          flushed = true;
          if (
            quitRequested ||
            restartRequested ||
            process.platform !== "darwin"
          )
            app.quit();
          else window?.close();
        };
        ipcMain.on("neoread:flushed", handler);
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
      const createdWindow = window;
      await createdWindow.loadURL(
        `${url}/${recoveryServer ? "?libraryRecovery=1" : ""}#token=${serverToken}`,
      );
      const feedback = startupWindow;
      await feedback?.waitForMinimumDisplay();
      let exitStartup: Awaited<ReturnType<typeof prepareStartupExit>> | undefined;
      const canShow = () =>
        !quitRequested && !quitting && !createdWindow.isDestroyed();
      if (canShow() && feedback && !feedback.nativeWindow.isDestroyed()) {
        try {
          // Paint the same loading surface over the real renderer before showing
          // it; a transparent native window would expose the desktop instead.
          createdWindow.setBounds(feedback.nativeWindow.getBounds());
          exitStartup = await prepareStartupExit(
            feedback.nativeWindow,
            createdWindow,
          );
        } catch (error) {
          if (canShow()) diagnostics?.record("startup.exit_prepare_failed", error);
        }
      }
      const reveal = canShow();
      if (reveal) {
        if (
          feedback &&
          !feedback.nativeWindow.isDestroyed() &&
          feedback.nativeWindow.isMaximized()
        )
          createdWindow.maximize();
        createdWindow.show();
      }
      feedback?.dispose();
      if (startupWindow === feedback) startupWindow = undefined;
      try {
        await exitStartup?.(reveal);
      } catch (error) {
        if (canShow()) diagnostics?.record("startup.exit_failed", error);
      }
      startupStage("startup.renderer_loaded");
      if (window === createdWindow && !createdWindow.isDestroyed()) {
        void proxyReady
          .then(async () => {
            if (
              quitting ||
              window !== createdWindow ||
              createdWindow.isDestroyed()
            )
              return;
            const updates = await startUpdateService(createdWindow);
            if (
              quitting ||
              window !== createdWindow ||
              createdWindow.isDestroyed()
            )
              updates.stop();
            else updateService = updates;
          })
          .catch((error) => {
            if (!quitting)
              diagnostics?.record("startup.updates_deferred_failed", error);
          });
      }
    };
    ipcMain.handle("neoread:clipboard-write", (event, text: unknown) =>
      writeClipboardText(event, text, window?.webContents, url),
    );
    ipcMain.handle(
      "neoread:clipboard-write-image",
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
    ipcMain.handle(
      "neoread:markdown-pdf",
      (event, id: unknown, html: unknown) => {
        settingsSender(event);
        return renderMarkdownPDF(id, html);
      },
    );
    ipcMain.handle("neoread:cancel-markdown-pdf", (event, id: unknown) => {
      settingsSender(event);
      if (typeof id === "string") cancelMarkdownPDF(id);
    });
    ipcMain.handle("neoread:library-location", (event) => {
      settingsSender(event);
      return activeLibrary || "";
    });
    ipcMain.handle("neoread:library-warning", (event) => {
      settingsSender(event);
      return libraryWarning;
    });
    ipcMain.handle("neoread:document-tab-active", (event, active: unknown) => {
      settingsSender(event);
      if (typeof active !== "boolean") throw new Error("Invalid tab state");
      documentTabActive = active;
    });
    ipcMain.handle("neoread:import-library", async (event) => {
      settingsSender(event);
      if (choosingLibrary || closing || restartRequested) return false;
      choosingLibrary = true;
      try {
        const selected = await dialog.showOpenDialog(window!, {
          title:
            "选择已有书库（包含 neoread.sqlite 或 reader.sqlite 的文件夹）",
          properties: ["openDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return false;
        const destination = await realpath(selected.filePaths[0]);
        const current = activeLibrary
          ? await realpath(activeLibrary).catch(() => undefined)
          : undefined;
        if (destination === current) return false;
        await validateLibraryDirectory(destination, serverBinary());
        const confirmed = await dialog.showMessageBox(window!, {
          type: "question",
          message: "导入已有书库并重启 NeoRead？",
          detail: `书库位置：${destination}\n将直接打开此书库，不复制或合并数据。当前书库保留。`,
          buttons: ["打开并重启", "取消"],
          defaultId: 0,
          cancelId: 1,
        });
        if (confirmed.response !== 0 || closing || quitting) return false;
        return await new Promise<boolean>((resolve) => {
          pendingLibraryMove = { destination, existing: true, resolve };
          restartRequested = true;
          app.quit();
        });
      } finally {
        choosingLibrary = false;
      }
    });
    ipcMain.handle("neoread:move-library", async (event) => {
      settingsSender(event);
      if (libraryWarning || choosingLibrary || closing || restartRequested)
        return false;
      choosingLibrary = true;
      try {
        const selected = await dialog.showOpenDialog(window!, {
          title: "选择书库保存位置（将在其中新建 NeoRead Library）",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return false;
        const destination = join(
          await realpath(selected.filePaths[0]),
          "NeoRead Library",
        );
        // The server's SQLite DSN treats ? as the start of query parameters.
        if (destination.includes("?"))
          throw new Error("书库路径不能包含 ?，请选择其他位置。");
        try {
          await lstat(destination);
          throw new Error(
            "所选位置已有 NeoRead Library 文件夹，请选择其他位置。",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const confirmed = await dialog.showMessageBox(window!, {
          type: "question",
          message: "迁移书库并重启 NeoRead？",
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
    ipcMain.handle("neoread:proxy-settings", async (event) => {
      settingsSender(event);
      return (await proxyReady).state();
    });
    ipcMain.handle("neoread:save-proxy-settings", async (event, value: unknown) => {
      settingsSender(event);
      return (await proxyReady).save(value);
    });
    ipcMain.handle("neoread:check-proxy", async (event, value: unknown) => {
      settingsSender(event);
      return (await proxyReady).check(value, serverBinary());
    });
    ipcMain.handle("neoread:command-line", (event) => {
      settingsSender(event);
      return commandLineStatus(commandLineHost());
    });
    ipcMain.handle("neoread:set-command-line", (event, installed: unknown) => {
      settingsSender(event);
      if (typeof installed !== "boolean") throw new Error("Invalid request");
      return setCommandLine(commandLineHost(), installed);
    });
    ipcMain.handle("neoread:restart", (event) => {
      settingsSender(event);
      if (closing || restartRequested) return;
      restartRequested = true;
      app.quit();
    });
    ipcMain.handle(
      "neoread:appearance",
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
        void saveStartupAppearance(app.getPath("userData"), appearance).catch(
          (error) =>
            diagnostics?.record("startup.appearance_cache_failed", error),
        );
      },
    );
    ipcMain.handle(
      "neoread:document-file",
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
    ipcMain.handle("neoread:take-links", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      linksClaimed = true;
      return pendingLinks.splice(0);
    });
    ipcMain.handle("neoread:take-opened-files", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      openedClaimed = true;
      return pendingOpened.splice(0);
    });
    ipcMain.handle(
      "neoread:open-codex-thread",
      async (event, threadId: unknown) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        await shell.openExternal(codexThreadURL(threadId));
      },
    );
    const citeOptions = () => ({
      platform: process.platform,
      home: homedir(),
      appData: app.getPath("appData"),
      plugins: citePluginsDirectory(),
      requestFolderAccess: async (folder: string) => {
        const selected = await dialog.showOpenDialog(window!, {
          title: "允许访问 Word 插件文件夹",
          message: "请选择当前文件夹，允许 NeoRead 访问 Word 引用插件。",
          buttonLabel: "允许访问",
          defaultPath: folder,
          properties: ["openDirectory"],
        });
        return selected.canceled ? null : selected.filePaths[0] || null;
      },
    });
    const citeKind = (kind: unknown): CitePluginKind => {
      if (kind !== "word" && kind !== "wps") throw new Error("Invalid plugin");
      return kind;
    };
    const fromWindow = (event: Electron.IpcMainInvokeEvent) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
    };
    let wordAccessDeniedFolder: string | null = null;
    ipcMain.handle("neoread:cite-plugins", async (event) => {
      fromWindow(event);
      wordAccessDeniedFolder = null;
      const started = Date.now();
      diagnostics?.logs.record("desktop", {
        level: "info",
        event: "cite_plugin.status_start",
      });
      try {
        const plugins = await citePluginStatus(citeOptions());
        diagnostics?.logs.record("desktop", {
          level: "info",
          event: "cite_plugin.status_finish",
          durationMs: Date.now() - started,
        });
        return plugins;
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        const code = failure?.code;
        diagnostics?.logs.record("desktop", {
          level: "error",
          event: "cite_plugin.status_failed",
          durationMs: Date.now() - started,
          errorCode: [
            "EPERM",
            "EACCES",
            "ENOENT",
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          ].includes(code || "")
            ? code
            : failure?.killed
              ? "timeout"
              : "status",
        });
        wordAccessDeniedFolder = wordAccessFolder(error, citeOptions());
        if (wordAccessDeniedFolder)
          throw new Error(
            "WORD_ACCESS_REQUIRED:访问被拒绝，请授权访问 Word 插件目录。",
          );
        if (code === "EACCES" || code === "EPERM")
          throw new Error(
            "访问被拒绝，请检查 Word 或 WPS 配置目录的访问权限。",
          );
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          throw new Error("Word 配置信息过多，无法完成检测。请导出诊断包。");
        if (failure?.killed)
          throw new Error("检测超时，请重试；如果持续失败，请导出诊断包。");
        if (
          error instanceof Error &&
          error.message.startsWith("Word 启动目录配置无效")
        )
          throw error;
        throw new Error(
          "无法读取插件状态，请重试；如果持续失败，请导出诊断包。",
        );
      }
    });
    ipcMain.handle("neoread:cite-plugin-authorize-word", async (event) => {
      fromWindow(event);
      if (!wordAccessDeniedFolder)
        throw new Error("请先重新检测 Word 插件状态。");
      const started = Date.now();
      diagnostics?.logs.record("desktop", {
        level: "info",
        event: "cite_plugin.authorize_start",
      });
      try {
        await authorizeWordPluginAccess(wordAccessDeniedFolder, citeOptions());
        diagnostics?.logs.record("desktop", {
          level: "info",
          event: "cite_plugin.authorize_finish",
          durationMs: Date.now() - started,
        });
      } catch (error) {
        const cancelled =
          error instanceof Error &&
          error.message === "已取消 Word 插件文件夹授权";
        diagnostics?.logs.record("desktop", {
          level: cancelled ? "info" : "error",
          event: cancelled
            ? "cite_plugin.authorize_cancelled"
            : "cite_plugin.authorize_failed",
          durationMs: Date.now() - started,
          ...(cancelled ? {} : { errorCode: "authorization" }),
        });
        throw error;
      }
    });
    ipcMain.handle("neoread:cite-plugin-install", async (event, kind) => {
      fromWindow(event);
      const plugin = citeKind(kind);
      const started = Date.now();
      diagnostics?.logs.record("desktop", {
        level: "info",
        event: "cite_plugin.install_start",
        kind: plugin,
      });
      try {
        await installCitePlugin(plugin, citeOptions());
        diagnostics?.logs.record("desktop", {
          level: "info",
          event: "cite_plugin.install_finish",
          kind: plugin,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        const cause = (error as Error).cause || error;
        const code = (cause as NodeJS.ErrnoException).code;
        diagnostics?.logs.record("desktop", {
          level: "error",
          event: "cite_plugin.install_failed",
          kind: plugin,
          durationMs: Date.now() - started,
          errorCode: ["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(code || "")
            ? code
            : "install",
        });
        throw error;
      }
      return citePluginStatus(citeOptions());
    });
    ipcMain.handle("neoread:cite-plugin-uninstall", async (event, kind) => {
      fromWindow(event);
      await uninstallCitePlugin(citeKind(kind), citeOptions());
      return citePluginStatus(citeOptions());
    });
    // A Word or WPS command opens a citation dialog here. Both systems keep a
    // background app from taking focus, so this has to insist.
    ipcMain.handle("neoread:focus-window", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      if (startupWindow) {
        showMainWindow();
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      if (process.platform === "darwin") app.focus({ steal: true });
      else {
        window.setAlwaysOnTop(true);
        window.focus();
        window.setAlwaysOnTop(false);
      }
      window.focus();
    });
    ipcMain.handle("neoread:open-external", async (event, url: unknown) => {
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
    ipcMain.handle("neoread:find-endnote", async (event, id: unknown) => {
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
    ipcMain.handle("neoread:cancel-endnote-search", (event, id: unknown) => {
      checkEndnoteSender(event);
      if (endnoteSearch && endnoteSearch.id === id)
        endnoteSearch.controller.abort();
    });
    ipcMain.handle(
      "neoread:choose-endnote",
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
    ipcMain.handle("neoread:choose-zotero-directory", async (event) => {
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
      "neoread:import",
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
          : (await importPaths(selected.filePaths, library, false, folder))
              .large;
      },
    );
    ipcMain.handle(
      "neoread:import-large",
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
        return (await importPaths(paths, library, true, folder)).documents;
      },
    );
    mainWindowOpening = reopenMainWindow();
    await mainWindowOpening;
    mainWindowOpening = undefined;
    if (quitRequested || quitting) return;
    if (!recoveryServer)
      citationService = startCitationService({
        url,
        token: serverToken,
        preload: join(__dirname, "preload.cjs"),
        record: (event) => diagnostics?.record(event),
      });
    if (migration && !recoveryServer)
      await promptLegacyCleanup(
        window!,
        serverBinary(),
        app.getPath("appData"),
        app.getPath("userData"),
        migration,
      );
    if (!recoveryServer) await flushFiles();
    ipcMain.handle("neoread:check-updates", (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid sender");
      return updateService?.check();
    });
  })
  .catch(async (error) => {
    if (quitting) return;
    diagnostics?.record("desktop.start_failed", error);
    if (diagnostics)
      await diagnostics.failure(
        error instanceof ReaderMigrationError
          ? "Reader 数据迁移未完成"
          : "无法打开 NeoRead",
        (error instanceof ReaderMigrationError ? `${error.message}\n\n` : "") +
          "可导出启动日志供开发者排查，然后退出重试。",
      );
    else dialog.showErrorBox("无法打开 NeoRead", String(error));
    flushed = true;
    app.quit();
  });
app.on("before-quit", (event) => {
  quitRequested = true;
  if (window && !window.isDestroyed() && !flushed) {
    event.preventDefault();
    window.close();
    return;
  }
  quitting = true;
  runtimeController.abort();
  startupWindow?.dispose();
  startupWindow = undefined;
  if (pendingReaderMigration) {
    event.preventDefault();
    if (!migrationController.signal.aborted) {
      migrationController.abort();
      void pendingReaderMigration.catch(() => {}).then(() => app.quit());
    }
    return;
  }
  if (restartRequested) {
    restartRequested = false;
    app.relaunch();
  }
  citationService?.stop();
  diagnostics?.record("desktop.stopping");
  updateService?.stop();
  proxySettings?.stop();
  recoveryServer?.stop();
  child?.kill();
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => app.quit());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !quitting) app.quit();
});
