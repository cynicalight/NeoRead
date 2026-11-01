import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startupAppearanceFromArguments } from "../startup-appearance";

// Exercise the real main-process close/flush handlers; only OS boundaries are fake.
let app: EventEmitter & {
  quit: () => void;
  relaunch: ReturnType<typeof vi.fn>;
};
let window: EventEmitter & {
  close: () => void;
  hide: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    mainFrame: { url: string };
  };
};
let windowOptions: { webPreferences?: { additionalArguments?: string[] } };
let minimumDisplay: ReturnType<typeof vi.fn>;
let finishMinimum: () => void;
let prepareExit: ReturnType<typeof vi.fn>;
let exitAnimation: ReturnType<typeof vi.fn>;
let finishPreparation: () => void;
let feedbackDestroyed = false;
let auxiliaryWindowOpen = false;
let quittingWindows = false;
let citationStop: ReturnType<typeof vi.fn>;
let ipc: EventEmitter;
let handlers: Map<string, (...args: any[]) => any>;
let migrate: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let serverSpawn: ReturnType<typeof vi.fn>;
let libraryDirectory: ReturnType<typeof vi.fn>;
let discoverPath: ReturnType<typeof vi.fn>;
let openProxy: ReturnType<typeof vi.fn>;
let detectMigration: ReturnType<typeof vi.fn>;
let confirmMigration: ReturnType<typeof vi.fn>;
let legacyMigrate: ReturnType<typeof vi.fn>;
let diagnosticLog: ReturnType<typeof vi.fn>;
let diagnostics: {
  record: ReturnType<typeof vi.fn>;
  failure: ReturnType<typeof vi.fn>;
};
let validate: ReturnType<typeof vi.fn>;
let saveLocation: ReturnType<typeof vi.fn>;
let recoveryStart: ReturnType<typeof vi.fn>;
let loadURL = vi.fn<(url: string) => void>();
let showMessageBox: ReturnType<typeof vi.fn>;
let showOpenDialog: ReturnType<typeof vi.fn>;
const event = () => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});
const move = () => handlers.get("neoread:move-library")!(event());

beforeEach(async ({ task }) => {
  vi.resetModules();
  feedbackDestroyed = false;
  exitAnimation = vi.fn(async () => {});
  prepareExit = vi.fn(() =>
    task.name.includes("while preparing startup exit")
      ? new Promise((resolve) => {
          finishPreparation = () => resolve(exitAnimation);
        })
      : Promise.resolve(exitAnimation),
  );
  vi.doMock("./startup-exit", () => ({ prepareStartupExit: prepareExit }));
  minimumDisplay = vi.fn(() =>
    task.name.includes("during the minimum display interval")
      ? new Promise<void>((resolve) => {
          finishMinimum = resolve;
        })
      : Promise.resolve(),
  );
  vi.doMock("./startup-appearance-cache", () => ({
    saveStartupAppearance: vi.fn(async () => {}),
  }));
  vi.doMock("./startup-window", () => ({
    createStartupWindow: vi.fn(() => ({
      nativeWindow: {
        isDestroyed: () => feedbackDestroyed,
        isMaximized: () => {
          if (feedbackDestroyed) throw new Error("Object has been destroyed");
          return false;
        },
        isMinimized: () => false,
        getBounds: () => ({ x: 50, y: 60, width: 1440, height: 940 }),
        show: vi.fn(),
        focus: vi.fn(),
      },
      waitForMinimumDisplay: minimumDisplay,
      load: async () => {},
      dispose: vi.fn(),
    })),
  }));
  loadURL = vi.fn();
  validate = vi.fn().mockResolvedValue(undefined);
  saveLocation = vi.fn().mockResolvedValue(undefined);
  recoveryStart = vi
    .fn()
    .mockResolvedValue({ url: "http://127.0.0.1:1234", stop: vi.fn() });
  vi.doMock("./library-recovery-server", () => ({
    startLibraryRecoveryServer: recoveryStart,
  }));
  auxiliaryWindowOpen = false;
  quittingWindows = false;
  citationStop = vi.fn();
  vi.doMock("./citation-service", () => ({
    startCitationService: vi.fn(() => ({ stop: citationStop })),
  }));
  handlers = new Map();
  ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, fn: (...args: any[]) => any) => {
      if (handlers.has(name)) throw new Error("Duplicate IPC handler");
      handlers.set(name, fn);
    },
  });
  app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => "/userdata",
    whenReady: async () => {},
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    relaunch: vi.fn(),
    quit: () => {
      let prevented = false;
      app.emit("before-quit", {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) {
        quittingWindows = true;
        window?.close();
        quittingWindows = false;
      }
    },
  });
  showOpenDialog = vi
    .fn()
    .mockResolvedValue({ canceled: false, filePaths: ["/destination"] });
  showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
  vi.doMock("electron", () => ({
    app,
    autoUpdater: new EventEmitter(),
    ipcMain: ipc,
    dialog: { showOpenDialog, showMessageBox, showErrorBox: vi.fn() },
    session: {
      defaultSession: {
        setProxy: async () => {},
        setPermissionRequestHandler() {},
      },
    },
    nativeTheme: {},
    shell: {},
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "http://127.0.0.1:1234/" },
        send: vi.fn(),
        setWindowOpenHandler() {},
      });
      constructor(options: typeof windowOptions) {
        super();
        windowOptions = options;
        window = this;
      }
      isDestroyed() {
        return this.destroyed;
      }
      async loadURL(url: string) {
        loadURL(url);
      }
      show = vi.fn();
      hide = vi.fn();
      setBounds = vi.fn();
      maximize = vi.fn();
      focus = vi.fn();
      isMinimized = () => false;
      close() {
        if (this.destroyed) return;
        let prevented = false;
        this.emit("close", {
          preventDefault() {
            prevented = true;
          },
        });
        if (!prevented) {
          this.destroyed = true;
          this.emit("closed");
          if (!auxiliaryWindowOpen && !quittingWindows)
            app.emit("window-all-closed");
        }
      }
    },
  }));
  serverSpawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (task.name.includes("server exits before readiness"))
        child.emit("exit", 1);
      else child.stdout.write('{"url":"http://127.0.0.1:1234"}\n');
    });
    return child;
  });
  vi.doMock("./citation-window", () => ({
    createCitationWindow: vi.fn(async () => ({})),
  }));
  vi.doMock("./cite-plugins", () => ({
    citePluginStatus: vi.fn(async () => []),
    wordAccessFolder: vi.fn(() => null as string | null),
    authorizeWordPluginAccess: vi.fn(async () => {}),
    installCitePlugin: vi.fn(),
    uninstallCitePlugin: vi.fn(),
  }));
  vi.doMock("node:child_process", () => ({ spawn: serverSpawn }));
  vi.doMock("node:fs/promises", () => ({
    readFile: vi.fn(),
    realpath: vi.fn(async (path: string) => path),
    lstat: async () => {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  }));
  stop = vi.fn().mockResolvedValue(undefined);
  migrate = vi.fn(
    async (
      _userData,
      _source,
      _target,
      _binary,
      shutdown: () => Promise<void>,
    ) => {
      await shutdown();
    },
  );
  libraryDirectory = vi.fn(async () => {
    if (task.name.startsWith("recovery:"))
      throw new Error("无法访问书库（ENOENT）");
    return "/old/library";
  });
  vi.doMock("./library-location", () => ({
    libraryDirectory,
    validateLibraryDirectory: validate,
    saveLibraryDirectory: saveLocation,
    migrateLibrary: migrate,
    stopLibraryServer: stop,
  }));
  detectMigration = vi.fn().mockResolvedValue("none");
  confirmMigration = vi.fn().mockResolvedValue(true);
  vi.doMock("./migration-confirmation", () => ({
    confirmReaderMigration: confirmMigration,
  }));
  legacyMigrate = vi.fn().mockResolvedValue({ status: "not-needed" });
  vi.doMock("./legacy-data", () => ({
    migrateReaderData: legacyMigrate,
    detectReaderMigration: detectMigration,
    declineReaderMigration: vi.fn(async () => {}),
    ReaderMigrationError: class extends Error {},
    promptLegacyCleanup: async () => {},
  }));
  discoverPath = vi.fn().mockResolvedValue("/bin");
  openProxy = vi.fn().mockResolvedValue({
    activeEnvironment: {},
    activeSettings: {},
    stop() {},
  });
  vi.doMock("./agent-path", () => ({ agentPath: discoverPath }));
  vi.doMock("./proxy-settings", () => ({
    ProxySettingsService: {
      open: openProxy,
    },
    electronProxyConfiguration: () => ({}),
  }));
  vi.doMock("./update-service", () => ({
    startUpdateService: async () => ({ stop() {} }),
  }));
  diagnostics = {
    record: vi.fn(),
    failure: vi.fn().mockResolvedValue(undefined),
  };
  diagnosticLog = vi.fn();
  vi.doMock("./diagnostic-service", () => ({
    startDiagnosticService: () => ({
      directory: "/logs",
      logs: { secrets: [], sessionId: "test", record: diagnosticLog },
      ...diagnostics,
      finishMigration() {},
      setSettings() {},
    }),
  }));
  vi.doMock("./clipboard", () => ({ writeClipboardText: vi.fn() }));
  vi.doMock("./endnote-discovery", () => ({ discoverEndNote: vi.fn() }));
  vi.doMock("./command-line", () => ({
    commandLineStatus: vi.fn(),
    setCommandLine: vi.fn(),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json({})),
  );
  vi.stubGlobal(
    "process",
    Object.assign(
      Object.create(process, {
        platform: {
          value: task.name.startsWith("macOS:") ? "darwin" : "win32",
        },
      }),
      {
        resourcesPath: "/resources",
        on: vi.fn(),
      },
    ),
  );
  await import("./index");
  if (task.name.includes("while preparing startup exit")) {
    await vi.waitFor(() => expect(prepareExit).toHaveBeenCalledOnce());
    return;
  }
  if (task.name.includes("during the minimum display interval")) {
    await vi.waitFor(() => expect(minimumDisplay).toHaveBeenCalledOnce());
    return;
  }
  if (task.name.includes("server exits before readiness")) {
    await vi.waitFor(() => expect(diagnostics.failure).toHaveBeenCalledOnce());
    return;
  }
  await vi.waitFor(() =>
    expect(handlers.has("neoread:check-updates")).toBe(true),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  [
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  ],
  [{ killed: true }, "timeout"],
  [{ code: "EACCES" }, "EACCES"],
  [{ code: "private-dynamic-value" }, "status"],
])(
  "reports plugin detection failures safely and allows a later query",
  async (details, errorCode) => {
    const { citePluginStatus } = await import("./cite-plugins");
    const failure = Object.assign(
      new Error("private registry contents"),
      details,
    );
    vi.mocked(citePluginStatus).mockRejectedValueOnce(failure);
    const query = handlers.get("neoread:cite-plugins")!;
    await expect(query(event())).rejects.toThrow(
      errorCode === "EACCES"
        ? "访问被拒绝"
        : errorCode === "timeout"
          ? "检测超时"
          : errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "配置信息过多"
            : "无法读取插件状态",
    );
    expect(diagnosticLog).toHaveBeenCalledWith("desktop", {
      level: "error",
      event: "cite_plugin.status_failed",
      durationMs: expect.any(Number),
      errorCode,
    });
    expect(JSON.stringify(diagnosticLog.mock.calls)).not.toContain("private");
    await expect(query(event())).resolves.toEqual([]);
    expect(diagnosticLog).toHaveBeenCalledWith("desktop", {
      level: "info",
      event: "cite_plugin.status_finish",
      durationMs: expect.any(Number),
    });
  },
);

it("only authorizes a Word folder after a denied status check", async () => {
  const { citePluginStatus, wordAccessFolder, authorizeWordPluginAccess } =
    await import("./cite-plugins");
  const query = handlers.get("neoread:cite-plugins")!;
  const authorize = handlers.get("neoread:cite-plugin-authorize-word")!;
  await expect(authorize(event())).rejects.toThrow("请先重新检测");
  vi.mocked(wordAccessFolder).mockReturnValueOnce("/word-folder");
  vi.mocked(citePluginStatus).mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  await expect(query(event())).rejects.toThrow("WORD_ACCESS_REQUIRED:");
  await authorize(event());
  expect(authorizeWordPluginAccess).toHaveBeenCalledWith(
    "/word-folder",
    expect.any(Object),
  );
  await query(event());
  await expect(authorize(event())).rejects.toThrow("请先重新检测");
});

it("waits for flushed reading data, then copies once despite repeated quit events", async () => {
  let complete!: () => void;
  migrate.mockImplementation(async (_u, _s, _d, _b, shutdown) => {
    await shutdown();
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  const result = move();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush"),
  );
  expect(migrate).not.toHaveBeenCalled();
  ipc.emit("neoread:flushed", event(), null);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  app.quit();
  ipc.emit("neoread:flushed", event(), null);
  expect(migrate).toHaveBeenCalledOnce();
  expect(app.relaunch).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  complete();
  expect(await result).toBe(true);
  expect(migrate).toHaveBeenCalledWith(
    "/userdata",
    "/old/library",
    join("/destination", "NeoRead Library"),
    expect.any(String),
    expect.any(Function),
  );
  expect(app.relaunch).toHaveBeenCalledOnce();
});

it("cancels migration after a save failure and allows returning to reading", async () => {
  const result = move();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush"),
  );
  ipc.emit("neoread:flushed", event(), "save failed");
  expect(await result).toBe(false);
  expect(migrate).not.toHaveBeenCalled();
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(showMessageBox).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ message: "阅读数据尚未保存" }),
  );
  showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await move()).toBe(false);
  expect(showOpenDialog).toHaveBeenCalledTimes(2);
});

it("reopens the old library after shutdown or copy fails", async () => {
  stop.mockRejectedValueOnce(new Error("shutdown failed"));
  const result = move();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush"),
  );
  ipc.emit("neoread:flushed", event(), null);
  expect(await result).toBe(false);
  expect(showMessageBox).toHaveBeenCalledWith(
    window,
    expect.objectContaining({
      message: "书库迁移失败",
      detail: expect.stringContaining("原书库已保留"),
    }),
  );
  expect(saveLocation).not.toHaveBeenCalled();
  expect(app.relaunch).toHaveBeenCalledOnce();
});

it("does not close the reader when the native confirmation is cancelled", async () => {
  showMessageBox.mockResolvedValueOnce({ response: 1 });
  expect(await move()).toBe(false);
  expect(window.webContents.send).not.toHaveBeenCalledWith("neoread:flush");
  expect(migrate).not.toHaveBeenCalled();
});

it.each(["/destination?question", "/parent?question/destination"])(
  "rejects an unsafe library path before confirming or closing: %s",
  async (selected) => {
    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [selected],
    });
    // A missing path guard must fail the test without waiting for a flush.
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(move()).rejects.toThrow("书库路径不能包含 ?");
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalledWith("neoread:flush");
    expect(stop).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(handlers.get("neoread:library-location")!(event())).toBe(
      "/old/library",
    );

    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await move()).toBe(false);
    expect(showOpenDialog).toHaveBeenCalledTimes(2);
  },
);

it("offers diagnostic export when legacy migration fails before opening the library", async () => {
  vi.resetModules();
  diagnostics.record.mockClear();
  diagnostics.failure.mockClear();
  const error = new Error("migration failed");
  legacyMigrate.mockRejectedValueOnce(error);
  const request = vi.mocked(fetch);
  request.mockClear();
  await import("./index");
  await vi.waitFor(() => expect(diagnostics.failure).toHaveBeenCalledOnce());
  expect(diagnostics.record).toHaveBeenCalledWith(
    "desktop.start_failed",
    error,
  );
  expect(request).not.toHaveBeenCalled();
});

it("waits for Reader migration before choosing or opening the library", async () => {
  vi.resetModules();
  handlers.clear();
  serverSpawn.mockClear();
  libraryDirectory.mockClear();
  legacyMigrate.mockClear();
  let finish!: (state: { status: string }) => void;
  legacyMigrate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await import("./index");
  await vi.waitFor(() => expect(legacyMigrate).toHaveBeenCalledOnce());
  expect(diagnosticLog).toHaveBeenCalledWith(
    "desktop",
    expect.objectContaining({ event: "startup.loading_visible" }),
  );
  expect(libraryDirectory).not.toHaveBeenCalled();
  expect(serverSpawn).not.toHaveBeenCalled();
  libraryDirectory.mockResolvedValue("/migrated/library");
  finish({ status: "completed" });
  await vi.waitFor(() => expect(serverSpawn).toHaveBeenCalledOnce());
  expect(serverSpawn.mock.calls[0][1]).toEqual(
    expect.arrayContaining(["--data", "/migrated/library"]),
  );
});

const importLibrary = () => handlers.get("neoread:import-library")!(event());
it("validates an imported library before shutdown and saves only after flush", async () => {
  const result = importLibrary();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush"),
  );
  expect(validate).toHaveBeenCalledOnce();
  expect(saveLocation).not.toHaveBeenCalled();
  ipc.emit("neoread:flushed", event(), null);
  expect(await result).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  expect(validate).toHaveBeenCalledTimes(2);
  expect(saveLocation).toHaveBeenCalledWith("/userdata", "/destination");
  expect(migrate).not.toHaveBeenCalled();
  expect(app.relaunch).toHaveBeenCalledOnce();
});
it("keeps the original configuration when import validation fails", async () => {
  validate.mockRejectedValueOnce(new Error("不是有效的书库"));
  await expect(importLibrary()).rejects.toThrow("不是有效的书库");
  expect(saveLocation).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(app.relaunch).not.toHaveBeenCalled();
});
it("keeps the original configuration when imported library changes before switching", async () => {
  validate
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("书库已被其他实例打开"));
  const result = importLibrary();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush"),
  );
  ipc.emit("neoread:flushed", event(), null);
  expect(await result).toBe(false);
  expect(saveLocation).not.toHaveBeenCalled();
});
it("recovery: opens settings without starting a library and can import an existing library", async () => {
  expect(recoveryStart).toHaveBeenCalledOnce();
  expect(loadURL).toHaveBeenCalledWith(
    expect.stringContaining("?libraryRecovery=1"),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(handlers.get("neoread:library-warning")!(event())).toContain("ENOENT");
  expect(await move()).toBe(false);
  const result = importLibrary();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush"),
  );
  ipc.emit("neoread:flushed", event(), null);
  expect(await result).toBe(true);
  expect(stop).not.toHaveBeenCalled();
  expect(saveLocation).toHaveBeenCalledWith("/userdata", "/destination");
  expect(app.relaunch).toHaveBeenCalledOnce();
});
it("recovery: restart retries without replacing the saved library", () => {
  handlers.get("neoread:restart")!(event());
  ipc.emit("neoread:flushed", event(), null);
  expect(saveLocation).not.toHaveBeenCalled();
  expect(app.relaunch).toHaveBeenCalledOnce();
});

it("can select a replacement when the active library directory has disappeared", async () => {
  const { realpath } = await import("node:fs/promises");
  vi.mocked(realpath)
    .mockResolvedValueOnce("/destination")
    .mockRejectedValueOnce(new Error("ENOENT"));
  showMessageBox.mockResolvedValueOnce({ response: 1 });
  expect(await importLibrary()).toBe(false);
  expect(validate).toHaveBeenCalledWith("/destination", expect.any(String));
  expect(saveLocation).not.toHaveBeenCalled();
});

it.each(["cancelled", "completed"])(
  "waits for a %s Reader migration child before quitting without opening a library",
  async (outcome) => {
    vi.resetModules();
    app.removeAllListeners("before-quit");
    serverSpawn.mockClear();
    libraryDirectory.mockClear();
    diagnostics.failure.mockClear();
    diagnostics.record.mockClear();
    legacyMigrate.mockClear();
    let finish!: (value: { status: string }) => void;
    let fail!: (error: Error) => void;
    legacyMigrate.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    await import("./index");
    await vi.waitFor(() => expect(legacyMigrate).toHaveBeenCalledOnce());
    const signal = legacyMigrate.mock.calls[0][4] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const quit = vi.spyOn(app, "quit");
    const preventDefault = vi.fn();
    app.emit("before-quit", { preventDefault });
    app.emit("before-quit", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    if (outcome === "cancelled") fail(new Error("cancelled"));
    else finish({ status: "completed" });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(libraryDirectory).not.toHaveBeenCalled();
    expect(serverSpawn).not.toHaveBeenCalled();
    expect(diagnostics.failure).not.toHaveBeenCalled();
    expect(diagnostics.record).not.toHaveBeenCalledWith(
      "desktop.start_failed",
      expect.anything(),
    );
  },
);

it("does not create an idle citation renderer at startup", async () => {
  const { createCitationWindow } = await import("./citation-window");
  expect(createCitationWindow).not.toHaveBeenCalled();
});

it("exits after saving the main window even with an auxiliary window open", async () => {
  auxiliaryWindowOpen = true;
  const quit = vi.spyOn(app, "quit");
  window.close();
  expect(window.hide).toHaveBeenCalledOnce();
  expect(serverSpawn.mock.results[0].value.kill).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
  ipc.emit("neoread:flushed", event(), null);
  await vi.waitFor(() => expect(quit).toHaveBeenCalled());
  expect(serverSpawn.mock.results[0].value.kill).toHaveBeenCalled();
});

it("macOS: destroys the main window, keeps services and recreates once on activation", async () => {
  const original = window;
  window.close();
  ipc.emit("neoread:flushed", event(), null);
  expect(serverSpawn.mock.results[0].value.kill).not.toHaveBeenCalled();
  expect(citationStop).not.toHaveBeenCalled();
  app.emit("activate");
  app.emit("activate");
  await vi.waitFor(() => expect(window).not.toBe(original));
  expect(loadURL).toHaveBeenCalledTimes(2);
  // IPC is registered once; the new renderer still saves before explicit quit.
  app.quit();
  expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush");
  expect(serverSpawn.mock.results[0].value.kill).not.toHaveBeenCalled();
  ipc.emit("neoread:flushed", event(), null);
  expect(serverSpawn.mock.results[0].value.kill).toHaveBeenCalledOnce();
  expect(citationStop).toHaveBeenCalledOnce();
});

it("macOS: reopens through second-instance and can cancel an explicit quit on save failure", async () => {
  const original = window;
  window.close();
  ipc.emit("neoread:flushed", event(), null);
  app.emit("second-instance", {}, []);
  await vi.waitFor(() => expect(window).not.toBe(original));
  app.quit();
  ipc.emit("neoread:flushed", event(), "save failed");
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled());
  expect(serverSpawn.mock.results[0].value.kill).not.toHaveBeenCalled();
  window.close();
  ipc.emit("neoread:flushed", event(), null);
  expect(serverSpawn.mock.results[0].value.kill).not.toHaveBeenCalled();
});

it("macOS: explicit quit without a main window stops the citation listener and server", async () => {
  window.close();
  ipc.emit("neoread:flushed", event(), null);
  app.quit();
  expect(citationStop).toHaveBeenCalledOnce();
  expect(serverSpawn.mock.results[0].value.kill).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "macOS: server failure prompts then quits (main window closed: %s)",
  async (closeMain) => {
    if (closeMain) {
      window.close();
      ipc.emit("neoread:flushed", event(), null);
    }
    const original = window;
    let dismiss!: () => void;
    diagnostics.failure.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve;
        }),
    );
    const quit = vi.spyOn(app, "quit");
    const child = serverSpawn.mock.results[0].value;
    child.emit("exit", 1);
    expect(diagnostics.failure).toHaveBeenCalledWith(
      "NeoRead 本地服务已停止",
      expect.any(String),
    );
    expect(citationStop).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    app.emit("activate");
    app.emit("second-instance", {}, []);
    await Promise.resolve();
    expect(window).toBe(original);
    expect(loadURL).toHaveBeenCalledOnce();
    dismiss();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(child.kill).toHaveBeenCalledOnce();
    expect(citationStop).toHaveBeenCalledOnce();
  },
);

it("server exits before readiness: reports only the startup failure", () => {
  expect(diagnostics.failure).toHaveBeenCalledWith(
    "无法打开 NeoRead",
    expect.any(String),
  );
  expect(diagnostics.failure).toHaveBeenCalledOnce();
  expect(serverSpawn.mock.results[0].value.kill).toHaveBeenCalledOnce();
});

it("macOS: normal shutdown does not report a server failure", () => {
  app.quit();
  ipc.emit("neoread:flushed", event(), null);
  serverSpawn.mock.results[0].value.emit("exit", 0);
  expect(diagnostics.failure).not.toHaveBeenCalled();
});

it("macOS: updating follows the explicit quit path even before app before-quit", async () => {
  const { autoUpdater } = await import("electron");
  autoUpdater.emit("before-quit-for-update");
  auxiliaryWindowOpen = true;
  window.close();
  expect(serverSpawn.mock.results[0].value.kill).not.toHaveBeenCalled();
  ipc.emit("neoread:flushed", event(), null);
  expect(citationStop).toHaveBeenCalledOnce();
  expect(serverSpawn.mock.results[0].value.kill).toHaveBeenCalledOnce();
});

it.each(["required", "resume"])(
  "holds all library work until confirmation for %s",
  async (status) => {
    vi.resetModules();
    handlers.clear();
    legacyMigrate.mockClear();
    libraryDirectory.mockClear();
    serverSpawn.mockClear();
    detectMigration.mockResolvedValue(status);
    let decide!: (value: boolean) => void;
    confirmMigration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    await import("./index");
    await vi.waitFor(() => expect(confirmMigration).toHaveBeenCalledOnce());
    expect(confirmMigration.mock.calls[0][2]).toBe(status === "resume");
    expect(legacyMigrate).not.toHaveBeenCalled();
    expect(libraryDirectory).not.toHaveBeenCalled();
    expect(serverSpawn).not.toHaveBeenCalled();
    decide(true);
    await vi.waitFor(() => expect(serverSpawn).toHaveBeenCalledOnce());
    expect(legacyMigrate).toHaveBeenCalledOnce();
  },
);
it.each(["required", "resume", "declined"])(
  "skipping %s migration continues startup without migrating",
  async (status) => {
    vi.resetModules();
    handlers.clear();
    legacyMigrate.mockClear();
    libraryDirectory.mockClear();
    serverSpawn.mockClear();
    detectMigration.mockResolvedValue(status);
    confirmMigration.mockResolvedValue(false);
    const quit = vi.spyOn(app, "quit").mockImplementation(() => {});
    await import("./index");
    await vi.waitFor(() =>
      expect(handlers.has("neoread:check-updates")).toBe(true),
    );
    expect(quit).not.toHaveBeenCalled();
    expect(legacyMigrate).not.toHaveBeenCalled();
    const { declineReaderMigration } = await import("./legacy-data");
    if (status === "declined") {
      expect(confirmMigration).not.toHaveBeenCalled();
      expect(declineReaderMigration).not.toHaveBeenCalled();
    } else expect(declineReaderMigration).toHaveBeenCalledWith("/userdata");
    expect(libraryDirectory).toHaveBeenCalledOnce();
    expect(serverSpawn).toHaveBeenCalledOnce();
    expect(handlers.has("neoread:import-library")).toBe(true);
    expect(handlers.has("neoread:move-library")).toBe(true);
  },
);

it("keeps loading feedback on top when activated during the minimum display interval", async () => {
  await vi.waitFor(() => expect(minimumDisplay).toHaveBeenCalledOnce());
  const mainWindow = window as typeof window & {
    show: ReturnType<typeof vi.fn>;
  };
  expect(mainWindow.show).not.toHaveBeenCalled();
  app.emit("activate");
  app.emit("second-instance", {}, ["NeoRead.exe"], "/");
  handlers.get("neoread:focus-window")!(event());
  expect(mainWindow.show).not.toHaveBeenCalled();
  finishMinimum();
  await vi.waitFor(() => expect(mainWindow.show).toHaveBeenCalledOnce());
});

it("shows the themed window while proxy and PATH discovery are still pending", async () => {
  vi.resetModules();
  handlers.clear();
  serverSpawn.mockClear();
  loadURL.mockClear();
  let finishProxy!: (value: unknown) => void;
  let finishPath!: (value: string) => void;
  openProxy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishProxy = resolve;
      }),
  );
  discoverPath.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPath = resolve;
      }),
  );
  const request = vi.mocked(fetch);
  request.mockClear();
  request.mockImplementation(async (input) =>
    Response.json(
      String(input).includes("/api/settings") ? { appearance: "dark" } : {},
    ),
  );
  await import("./index");
  await vi.waitFor(() =>
    expect(handlers.has("neoread:check-updates")).toBe(true),
  );
  expect(serverSpawn).toHaveBeenCalledOnce();
  expect(serverSpawn.mock.calls[0][1]).toContain("--desktop-runtime");
  expect(loadURL).toHaveBeenCalledOnce();
  const { nativeTheme } = await import("electron");
  expect(nativeTheme.themeSource).toBe("dark");
  expect(
    startupAppearanceFromArguments(
      windowOptions.webPreferences?.additionalArguments ?? [],
    ),
  ).toEqual({ appearance: "dark" });
  expect(
    request.mock.calls.some(([url]) =>
      String(url).includes("/api/desktop-runtime/"),
    ),
  ).toBe(false);
  finishProxy({
    activeEnvironment: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    activeSettings: {},
    stop() {},
  });
  await vi.waitFor(() =>
    expect(
      request.mock.calls.some(([url]) =>
        String(url).endsWith("/desktop-runtime/network"),
      ),
    ).toBe(true),
  );
  expect(
    request.mock.calls.some(([url]) =>
      String(url).endsWith("/desktop-runtime/path"),
    ),
  ).toBe(false);
  finishPath("/resolved/bin");
  await vi.waitFor(() =>
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/desktop-runtime/path") &&
          init?.body === JSON.stringify({ PATH: "/resolved/bin" }),
      ),
    ).toBe(true),
  );
});
it("does not show the main window until its theme request completes", async () => {
  vi.resetModules();
  handlers.clear();
  loadURL.mockClear();
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(async (input) =>
    String(input).includes("/api/settings")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Response.json({}),
  );
  await import("./index");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(loadURL).not.toHaveBeenCalled();
  finish(Response.json({ appearance: "light" }));
  await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce());
  const { nativeTheme } = await import("electron");
  expect(nativeTheme.themeSource).toBe("light");
});

it("reports a theme read failure without showing a fallback-themed window", async () => {
  vi.resetModules();
  handlers.clear();
  loadURL.mockClear();
  diagnostics.failure.mockClear();
  vi.mocked(fetch).mockImplementation(async (input) =>
    String(input).includes("/api/settings")
      ? new Response("unavailable", { status: 503 })
      : Response.json({}),
  );
  await import("./index");
  await vi.waitFor(() => expect(diagnostics.failure).toHaveBeenCalledOnce());
  expect(loadURL).not.toHaveBeenCalled();
});

it.each([null, "save failed"])(
  "does not reveal the main window when quitting during the minimum display interval (flush: %s)",
  async (error) => {
    const main = window as typeof window & { show: ReturnType<typeof vi.fn> };
    const { createStartupWindow } = await import("./startup-window");
    const startup = vi.mocked(createStartupWindow).mock.results[0].value;
    app.quit();
    expect(window.webContents.send).toHaveBeenCalledWith("neoread:flush");
    // Closing the loading window releases its timer while renderer flush is pending.
    finishMinimum();
    await vi.waitFor(() => expect(startup.dispose).toHaveBeenCalled());
    expect(main.show).not.toHaveBeenCalled();
    ipc.emit("neoread:flushed", event(), error);
    if (error) await vi.waitFor(() => expect(main.show).toHaveBeenCalledOnce());
  },
);

it("installs loading feedback before showing the real window and reveals it after disposing the old window", async () => {
  const main = window as typeof window & {
    show: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
  };
  const { createStartupWindow } = await import("./startup-window");
  const feedback = vi.mocked(createStartupWindow).mock.results[0].value;
  expect(main.setBounds).toHaveBeenCalledWith({
    x: 50, y: 60, width: 1440, height: 940,
  });
  expect(prepareExit).toHaveBeenCalledWith(feedback.nativeWindow, main);
  expect(prepareExit.mock.invocationCallOrder[0]).toBeLessThan(
    main.show.mock.invocationCallOrder[0],
  );
  expect(main.show.mock.invocationCallOrder[0]).toBeLessThan(
    feedback.dispose.mock.invocationCallOrder[0],
  );
  expect(feedback.dispose.mock.invocationCallOrder[0]).toBeLessThan(
    exitAnimation.mock.invocationCallOrder[0],
  );
  expect(exitAnimation).toHaveBeenCalledWith(true);
});

it("does not show the real window when quitting while preparing startup exit", async () => {
  const main = window as typeof window & { show: ReturnType<typeof vi.fn> };
  app.quit();
  finishPreparation();
  await vi.waitFor(() => expect(exitAnimation).toHaveBeenCalledWith(false));
  expect(main.show).not.toHaveBeenCalled();
  ipc.emit("neoread:flushed", event(), null);
});

it("returns to reading after cancelling quit while preparing startup exit", async () => {
  app.quit();
  feedbackDestroyed = true;
  ipc.emit("neoread:flushed", event(), "save failed");
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled());
  finishPreparation();
  await vi.waitFor(() => expect(handlers.has("neoread:check-updates")).toBe(true));
  expect(exitAnimation).toHaveBeenCalledWith(true);
  expect(diagnostics.failure).not.toHaveBeenCalled();
});

it("continues startup if the refusal marker cannot be saved", async () => {
  vi.resetModules();
  handlers.clear();
  legacyMigrate.mockClear();
  serverSpawn.mockClear();
  detectMigration.mockResolvedValue("resume");
  confirmMigration.mockResolvedValue(false);
  const { declineReaderMigration } = await import("./legacy-data");
  vi.mocked(declineReaderMigration).mockRejectedValueOnce(new Error("disk full"));
  await import("./index");
  await vi.waitFor(() => expect(handlers.has("neoread:check-updates")).toBe(true));
  expect(legacyMigrate).not.toHaveBeenCalled();
  expect(serverSpawn).toHaveBeenCalledOnce();
  expect(diagnostics.record).toHaveBeenCalledWith("migration.decline_save_failed", expect.any(Error));
});

it("acknowledges a discarded note warning and continues closing without a retry choice", async () => {
  const quit = vi.spyOn(app, "quit");
  window.close();
  ipc.emit("neoread:flushed", event(), null, true);
  await vi.waitFor(() => expect(quit).toHaveBeenCalled());
  expect(showMessageBox).toHaveBeenCalledWith(
    window,
    expect.objectContaining({
      message: "论文笔记保存失败",
      buttons: ["知道了"],
    }),
  );
});
