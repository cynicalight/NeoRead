import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Exercise the real main-process close/flush handlers; only OS boundaries are fake.
let app: EventEmitter & {
  quit: () => void;
  relaunch: ReturnType<typeof vi.fn>;
};
let window: EventEmitter & {
  close: () => void;
  webContents: EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    mainFrame: { url: string };
  };
};
let ipc: EventEmitter;
let handlers: Map<string, (...args: any[]) => any>;
let migrate: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let serverSpawn: ReturnType<typeof vi.fn>;
let libraryDirectory: ReturnType<typeof vi.fn>;
let legacyMigrate: ReturnType<typeof vi.fn>;
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
  loadURL = vi.fn();
  validate = vi.fn().mockResolvedValue(undefined);
  saveLocation = vi.fn().mockResolvedValue(undefined);
  recoveryStart = vi
    .fn()
    .mockResolvedValue({ url: "http://127.0.0.1:1234", stop: vi.fn() });
  vi.doMock("./library-recovery-server", () => ({
    startLibraryRecoveryServer: recoveryStart,
  }));
  handlers = new Map();
  ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn),
  });
  app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => "/userdata",
    whenReady: async () => {},
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    relaunch: vi.fn(),
    quit: () => {
      app.emit("before-quit", { preventDefault() {} });
    },
  });
  showOpenDialog = vi
    .fn()
    .mockResolvedValue({ canceled: false, filePaths: ["/destination"] });
  showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
  vi.doMock("electron", () => ({
    app,
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
      constructor() {
        super();
        window = this;
      }
      isDestroyed() {
        return this.destroyed;
      }
      async loadURL(url: string) {
        loadURL(url);
      }
      close() {
        let prevented = false;
        this.emit("close", {
          preventDefault() {
            prevented = true;
          },
        });
        if (!prevented) {
          this.destroyed = true;
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
    queueMicrotask(() =>
      child.stdout.write('{"url":"http://127.0.0.1:1234"}\n'),
    );
    return child;
  });
  vi.doMock("./cite-plugins", () => ({
    citePluginStatus: vi.fn(async () => []),
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
  legacyMigrate = vi.fn().mockResolvedValue({ status: "not-needed" });
  vi.doMock("./legacy-data", () => ({
    migrateReaderData: legacyMigrate,
    ReaderMigrationError: class extends Error {},
    promptLegacyCleanup: async () => {},
  }));
  vi.doMock("./agent-path", () => ({ agentPath: async () => "/bin" }));
  vi.doMock("./proxy-settings", () => ({
    ProxySettingsService: {
      open: async () => ({
        activeEnvironment: {},
        activeSettings: {},
        stop() {},
      }),
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
  vi.doMock("./diagnostic-service", () => ({
    startDiagnosticService: () => ({
      directory: "/logs",
      logs: { secrets: [], sessionId: "test", record: vi.fn() },
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
  vi.stubGlobal(
    "process",
    Object.assign(Object.create(process), {
      resourcesPath: "/resources",
      on: vi.fn(),
    }),
  );
  await import("./index");
  await vi.waitFor(() =>
    expect(handlers.has("neoread:check-updates")).toBe(true),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    "/destination/NeoRead Library",
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
  expect(handlers.get("neoread:library-location")!(event())).toBe(
    "/old/library",
  );
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
