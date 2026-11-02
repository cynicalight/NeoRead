import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  directory: "",
  save: vi.fn(),
  message: vi.fn(),
  menu: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.directory,
    getVersion: () => "0.5.1",
    isPackaged: false,
    on: vi.fn(),
  },
  dialog: { showSaveDialog: mocks.save, showMessageBox: mocks.message },
  shell: { showItemInFolder: mocks.reveal },
  Menu: {
    getApplicationMenu: () => null,
    buildFromTemplate: (value: unknown) => value,
    setApplicationMenu: mocks.menu,
  },
}));
import { startDiagnosticService } from "./diagnostic-service";

it("keeps native export usable after failure and rejects events from other frames", async () => {
  mocks.directory = mkdtempSync(join(tmpdir(), "neoread-native-diagnostics-"));
  const originalWarn = console.warn,
    originalError = console.error;
  const originalListeners = process.listeners("uncaughtExceptionMonitor");
  const mainFrame = {};
  const webContents = { mainFrame };
  const window = {
    webContents,
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
  const service = startDiagnosticService(() => window);
  try {
    expect(JSON.stringify(mocks.menu.mock.calls)).toContain("导出诊断包");
    const recorded = vi.spyOn(service.logs, "record");
    const input = { level: "info", event: "api.finish", status: 200 };
    service.receive(
      { sender: {}, senderFrame: mainFrame } as Electron.IpcMainEvent,
      input,
    );
    service.receive(
      { sender: webContents, senderFrame: {} } as Electron.IpcMainEvent,
      input,
    );
    expect(recorded).not.toHaveBeenCalled();
    service.receive(
      { sender: webContents, senderFrame: mainFrame } as Electron.IpcMainEvent,
      input,
    );
    expect(recorded).toHaveBeenCalledWith("renderer", input);
    expect(() =>
      service.invoke({
        sender: {},
        senderFrame: mainFrame,
      } as Electron.IpcMainInvokeEvent),
    ).toThrow("Invalid sender");
    const output = join(mocks.directory, "report.zip");
    mocks.save.mockResolvedValue({ canceled: false, filePath: output });
    mocks.message
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 });
    const exporter = vi
      .spyOn(service.logs, "export")
      .mockImplementation(async (path) => {
        writeFileSync(path, "test ZIP");
        return { files: 1, missing: 0, filename: "test.zip" };
      });
    const failure = service.failure("服务已停止", "可导出后退出");
    const simultaneous = service.failure("界面已停止", "另一条故障");
    expect(simultaneous).toBe(failure);
    await failure;
    expect(exporter).toHaveBeenCalledOnce();
    expect(mocks.reveal).toHaveBeenCalledWith(output);
    expect(mocks.message.mock.calls[0][0].buttons).toEqual([
      "导出诊断包",
      "退出",
    ]);
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await service.export()).toBe(false);
    mocks.save.mockResolvedValue({
      canceled: false,
      filePath: join(mocks.directory, "missing", "report.zip"),
    });
    mocks.message.mockResolvedValue({ response: 0 });
    await expect(service.export()).rejects.toThrow("无法导出诊断包");
    expect(mocks.message).toHaveBeenCalledWith(
      expect.objectContaining({ message: "无法导出诊断包" }),
    );
    const before = recorded.mock.calls.length;
    Object.defineProperty(webContents, "mainFrame", {
      get: () => {
        throw new Error("Frame disposed");
      },
    });
    expect(() =>
      service.receive(
        {
          sender: webContents,
          senderFrame: mainFrame,
        } as Electron.IpcMainEvent,
        input,
      ),
    ).not.toThrow();
    expect(recorded.mock.calls.length).toBe(before);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    for (const listener of process.listeners("uncaughtExceptionMonitor"))
      if (!originalListeners.includes(listener))
        process.removeListener("uncaughtExceptionMonitor", listener);
    rmSync(mocks.directory, { recursive: true, force: true });
  }
});

it("exports only the active library's failure files, including after startup fails", async () => {
  mocks.directory = mkdtempSync(join(tmpdir(), "neoread-active-diagnostics-"));
  const originalWarn = console.warn,
    originalError = console.error;
  const listeners = process.listeners("uncaughtExceptionMonitor");
  const oldLibrary = join(mocks.directory, "library");
  let active: string | undefined;
  const custom = join(mocks.directory, "custom-library");
  for (const [root, name] of [
    [oldLibrary, "old-backup.txt"],
    [custom, "current-library.txt"],
  ]) {
    const folder = join(root, "cache", "a".repeat(32), "translation-failures");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, name), "failure diagnostic");
  }
  const service = startDiagnosticService(
    () => undefined,
    () => active,
  );
  try {
    for (const location of [custom, undefined]) {
      active = location;
      const output = join(
        mocks.directory,
        location ? "current.zip" : "startup-failed.zip",
      );
      mocks.save.mockResolvedValue({ canceled: false, filePath: output });
      expect(await service.export()).toBe(true);
      const names = execFileSync(
        process.platform === "win32" ? "python" : "python3",
        [
          "-c",
          "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))",
          output,
        ],
        { encoding: "utf8" },
      );
      expect(names).not.toContain("old-backup.txt");
      if (location) expect(names).toContain("current-library.txt");
      else expect(names).not.toContain("current-library.txt");
      expect(names).toContain("manifest.json");
    }
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    for (const listener of process.listeners("uncaughtExceptionMonitor"))
      if (!listeners.includes(listener))
        process.removeListener("uncaughtExceptionMonitor", listener);
    rmSync(mocks.directory, { recursive: true, force: true });
  }
});

it("exports migration logs before a library exists and retains them after log activation", async () => {
  mocks.directory = mkdtempSync(
    join(tmpdir(), "neoread-migration-diagnostics-"),
  );
  const originalWarn = console.warn,
    originalError = console.error;
  const listeners = process.listeners("uncaughtExceptionMonitor");
  const service = startDiagnosticService(
    () => undefined,
    () => undefined,
    true,
  );
  try {
    expect(service.directory).toBe(join(mocks.directory, ".migration-logs"));
    service.record("migration.failed", new Error("PRIVATE_DOCUMENT_SENTINEL"));
    for (const activated of [false, true]) {
      if (activated) {
        service.finishMigration();
        expect(service.directory).toBe(join(mocks.directory, "logs"));
        service.record("server.ready");
      }
      const output = join(
        mocks.directory,
        activated ? "after.zip" : "failed.zip",
      );
      mocks.save.mockResolvedValue({ canceled: false, filePath: output });
      expect(await service.export()).toBe(true);
      const content = execFileSync(
        process.platform === "win32" ? "python" : "python3",
        [
          "-c",
          "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.read(n).decode() for n in z.namelist() if n.endswith('.jsonl')))",
          output,
        ],
        { encoding: "utf8" },
      );
      expect(content).toContain("migration.failed");
      expect(content).not.toContain("PRIVATE_DOCUMENT_SENTINEL");
      if (activated) expect(content).toContain("server.ready");
    }
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    for (const listener of process.listeners("uncaughtExceptionMonitor"))
      if (!listeners.includes(listener))
        process.removeListener("uncaughtExceptionMonitor", listener);
    rmSync(mocks.directory, { recursive: true, force: true });
  }
});
