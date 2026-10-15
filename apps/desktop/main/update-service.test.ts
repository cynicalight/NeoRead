import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  dialog: vi.fn(),
  fetch: vi.fn(),
  download: vi.fn(),
  open: vi.fn(),
  external: vi.fn(),
  rm: vi.fn(),
  inPlace: vi.fn(),
  stage: vi.fn(),
  quitAndInstall: vi.fn(),
  spawn: vi.fn(),
  app: {
    quit: vi.fn(),
    once: vi.fn(),
    isPackaged: true,
    getPath: (name: string) =>
      name === "exe"
        ? "/Applications/Reader.app/Contents/MacOS/Reader"
        : "/test/user-data",
    getVersion: () => "0.1.0",
  },
}));
vi.mock("electron", () => ({
  app: mocks.app,
  autoUpdater: { quitAndInstall: mocks.quitAndInstall },
  dialog: { showMessageBox: mocks.dialog },
  net: { fetch: mocks.fetch },
  shell: { openPath: mocks.open, openExternal: mocks.external },
}));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.read,
  writeFile: mocks.write,
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: mocks.rm,
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./update-download", () => ({ downloadUpdate: mocks.download }));
vi.mock("./mac-squirrel", () => ({
  canUpdateInPlace: mocks.inPlace,
  stageUpdate: mocks.stage,
}));
import { startUpdateService } from "./update-service";
import { day } from "./updates";
let stop: (() => void) | undefined;
let assets: string[];
const send = vi.fn();
const window = {
  isDestroyed: () => false,
  setProgressBar: vi.fn(),
  webContents: { send },
} as unknown as BrowserWindow;
// Simulates a 200 MB download that reports progress before resolving.
const downloadWithProgress = (path: string) =>
  mocks.download.mockImplementationOnce(
    async (
      _update: unknown,
      _directory: string,
      _request: unknown,
      onProgress?: (received: number, total?: number) => void,
    ) => {
      for (const mb of [0, 50, 50.001, 200])
        onProgress?.(mb * 1024 * 1024, 200 * 1024 * 1024);
      return path;
    },
  );
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(day * 10);
  vi.clearAllMocks();
  assets = [
    "Reader-0.2.0-mac-arm64.dmg",
    "Reader-0.2.0-win-x64.exe",
    "SHA256SUMS.txt",
  ];
  mocks.inPlace.mockResolvedValue(true);
  mocks.stage.mockResolvedValue(undefined);
  mocks.app.isPackaged = true;
  mocks.read.mockRejectedValue(new Error("missing"));
  mocks.dialog.mockResolvedValue({ response: 1 });
  mocks.fetch.mockImplementation(async () =>
    Response.json({
      tag_name: "v0.2.0",
      draft: false,
      prerelease: false,
      assets: assets.map((name) => ({
        name,
        state: "uploaded",
        browser_download_url: `https://github.com/cynicalight/reader/releases/download/v0.2.0/${name}`,
      })),
    }),
  );
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("checks on startup, coalesces manual checks, and does not prompt again within a day", async () => {
  const service = await startUpdateService(window);
  stop = service.stop;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.dialog).toHaveBeenCalledTimes(1);
  expect(mocks.download).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(day - 60_000);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  await Promise.all([service.check(), service.check()]);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.dialog).toHaveBeenCalledTimes(2);
});
it("respects persisted check times and stops scheduled work", async () => {
  mocks.read.mockResolvedValue(JSON.stringify({ lastChecked: day * 10 }));
  const service = await startUpdateService(window);
  stop = service.stop;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.fetch).not.toHaveBeenCalled();
  service.stop();
  await vi.advanceTimersByTimeAsync(day * 2);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("opens only verified downloads and reports download failures even after a background prompt", async () => {
  mocks.dialog.mockResolvedValue({ response: 0 });
  mocks.download.mockRejectedValueOnce(new Error("安装包完整性校验失败"));
  const service = await startUpdateService(window);
  stop = service.stop;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.dialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ type: "error", detail: "安装包完整性校验失败" }),
  );
  mocks.download.mockResolvedValue("/test/verified.dmg");
  mocks.open.mockResolvedValue("");
  await service.check();
  expect(mocks.open).toHaveBeenCalledWith("/test/verified.dmg");
  expect(window.setProgressBar).toHaveBeenLastCalledWith(-1);
});
it("keeps a Mac running after opening the DMG", async () => {
  mocks.dialog.mockResolvedValue({ response: 0 });
  mocks.download.mockResolvedValue("/test/verified.dmg");
  mocks.open.mockResolvedValue("");
  const service = await startUpdateService(window);
  stop = service.stop;
  await service.check();
  expect(mocks.open).toHaveBeenCalledWith("/test/verified.dmg");
  expect(mocks.app.quit).not.toHaveBeenCalled();
});
it("shows download progress in the taskbar and the app, then clears it", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  mocks.spawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });
  mocks.dialog.mockResolvedValue({ response: 0 });
  downloadWithProgress("C:\\test\\Reader-0.2.0-win-x64.exe");
  const service = await startUpdateService(window);
  stop = service.stop;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(window.setProgressBar).toHaveBeenCalledWith(0.25);
  const reports = send.mock.calls
    .filter(([channel]) => channel === "reader:update-progress")
    .map(([, progress]) => progress);
  // Steps within the same percent are not sent again.
  expect(reports).toEqual([
    {
      version: "0.2.0",
      phase: "download",
      received: 0,
      total: 200 * 1024 * 1024,
    },
    {
      version: "0.2.0",
      phase: "download",
      received: 50 * 1024 * 1024,
      total: 200 * 1024 * 1024,
    },
    {
      version: "0.2.0",
      phase: "download",
      received: 200 * 1024 * 1024,
      total: 200 * 1024 * 1024,
    },
    null,
  ]);
  expect(window.setProgressBar).toHaveBeenLastCalledWith(-1);
});
it("clears download progress before showing a download error", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  mocks.download.mockImplementationOnce(
    async (
      _update: unknown,
      _directory: string,
      _request: unknown,
      onProgress?: (received: number, total?: number) => void,
    ) => {
      onProgress?.(1024 * 1024, 2 * 1024 * 1024);
      throw new Error("connection lost");
    },
  );
  let clearedBeforeError = false;
  mocks.dialog.mockImplementation(async (_window, options) => {
    if (options.type === "error")
      clearedBeforeError = send.mock.calls.some(
        ([channel, progress]) =>
          channel === "reader:update-progress" && progress === null,
      );
    return { response: 0 };
  });
  const service = await startUpdateService(window);
  stop = service.stop;
  await service.check();
  expect(mocks.dialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ type: "error", detail: "connection lost" }),
  );
  expect(clearedBeforeError).toBe(true);
});
it("caps the taskbar progress when more bytes arrive than announced", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  mocks.spawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });
  mocks.dialog.mockResolvedValue({ response: 0 });
  mocks.download.mockImplementationOnce(
    async (
      _update: unknown,
      _directory: string,
      _request: unknown,
      onProgress?: (received: number, total?: number) => void,
    ) => {
      onProgress?.(3 * 1024 * 1024, 2 * 1024 * 1024);
      return "C:\\test\\Reader-0.2.0-win-x64.exe";
    },
  );
  const service = await startUpdateService(window);
  stop = service.stop;
  await service.check();
  expect(window.setProgressBar).toHaveBeenCalledWith(1);
  expect(window.setProgressBar).not.toHaveBeenCalledWith(1.5);
});
it("installs the verified Windows update silently after Reader quits", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  const child = { on: vi.fn(), unref: vi.fn() };
  child.on.mockReturnValue(child);
  mocks.spawn.mockReturnValue(child);
  mocks.dialog.mockResolvedValue({ response: 0 });
  mocks.download.mockResolvedValue("C:\\test\\Reader-0.2.0-win-x64.exe");
  const service = await startUpdateService(window);
  stop = service.stop;
  await service.check();
  expect(mocks.download).toHaveBeenCalledWith(
    expect.objectContaining({ installer: "Reader-0.2.0-win-x64.exe" }),
    expect.any(String),
    expect.any(Function),
    expect.any(Function),
  );
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.app.quit).toHaveBeenCalledTimes(1);
  // The installer waits for the reading flush and server shutdown.
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.app.once).toHaveBeenCalledWith("quit", expect.any(Function));
  // A quit cancelled to keep reading arms the same installer only once.
  await service.check();
  expect(mocks.app.once).toHaveBeenCalledTimes(1);
  mocks.app.once.mock.calls[0][1]();
  expect(mocks.spawn).toHaveBeenCalledWith(
    "C:\\test\\Reader-0.2.0-win-x64.exe",
    ["--updated", "/S", "--force-run"],
    { detached: true, stdio: "ignore" },
  );
  expect(child.unref).toHaveBeenCalled();
});
it("stages a signed Mac update silently and installs it on restart", async () => {
  assets.push("Reader-0.2.0-mac-arm64.zip");
  downloadWithProgress("/test/user-data/updates/x/Reader.zip");
  mocks.dialog.mockResolvedValue({ response: 0 });
  const service = await startUpdateService(window);
  stop = service.stop;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.inPlace).toHaveBeenCalledWith("/Applications/Reader.app");
  expect(mocks.download).toHaveBeenCalledWith(
    expect.objectContaining({
      installer: "Reader-0.2.0-mac-arm64.zip",
      downloadURL:
        "https://github.com/cynicalight/reader/releases/download/v0.2.0/Reader-0.2.0-mac-arm64.zip",
    }),
    "/test/user-data/updates",
    expect.any(Function),
    expect.any(Function),
  );
  expect(mocks.stage).toHaveBeenCalledWith(
    expect.anything(),
    "/test/user-data/updates/x/Reader.zip",
  );
  expect(mocks.rm).toHaveBeenCalledWith("/test/user-data/updates/x", {
    recursive: true,
    force: true,
  });
  // The background check asks nothing before the update is ready.
  expect(mocks.dialog).toHaveBeenCalledTimes(1);
  expect(mocks.dialog).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ message: "Reader 0.2.0 已准备就绪" }),
  );
  expect(window.setProgressBar).not.toHaveBeenCalledWith(2);
  expect(send).not.toHaveBeenCalledWith(
    "reader:update-progress",
    expect.objectContaining({ phase: "download" }),
  );
  expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1);
  expect(mocks.open).not.toHaveBeenCalled();
  // A staged version is not downloaded again before the restart.
  await service.check();
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.dialog).toHaveBeenCalledTimes(2);
});
it("falls back to the DMG when the app cannot replace itself", async () => {
  assets.push("Reader-0.2.0-mac-arm64.zip");
  mocks.inPlace.mockResolvedValue(false);
  const service = await startUpdateService(window);
  stop = service.stop;
  await service.check();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.dialog).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ buttons: ["下载安装包", "稍后"] }),
  );
  mocks.inPlace.mockResolvedValue(true);
  mocks.download.mockResolvedValue("/test/user-data/updates/x/Reader.zip");
  mocks.stage.mockRejectedValue(
    new Error("Code signature did not pass validation"),
  );
  await service.check();
  expect(mocks.rm).toHaveBeenCalled();
  expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  expect(mocks.dialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ buttons: ["下载安装包", "稍后"] }),
  );
});
it("does not contact GitHub in development mode", async () => {
  mocks.app.isPackaged = false;
  const service = await startUpdateService(window);
  stop = service.stop;
  await vi.advanceTimersByTimeAsync(15_000);
  await service.check();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.dialog).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ message: "开发模式不检查更新" }),
  );
});

it.each([0, 1])(
  "offers the official release page after a manual check fails (choice %s)",
  async (response) => {
    mocks.fetch.mockResolvedValue(
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    mocks.dialog.mockResolvedValue({ response });
    mocks.external.mockResolvedValue(undefined);
    const service = await startUpdateService(window);
    stop = service.stop;
    await service.check();
    expect(mocks.dialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        detail: expect.stringContaining("限流"),
        buttons: ["打开发布页", "关闭"],
        cancelId: 1,
      }),
    );
    if (response === 0)
      expect(mocks.external).toHaveBeenCalledWith(
        "https://github.com/cynicalight/reader/releases/latest",
      );
    else expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  },
);

it("keeps a background rate limit failure silent", async () => {
  mocks.fetch.mockResolvedValue(new Response("", { status: 429 }));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const service = await startUpdateService(window);
    stop = service.stop;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.dialog).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

it("reports a browser launch failure without rejecting the update check", async () => {
  mocks.fetch.mockResolvedValue(new Response("", { status: 403 }));
  mocks.dialog.mockResolvedValue({ response: 0 });
  mocks.external.mockRejectedValueOnce(new Error("browser unavailable"));
  const service = await startUpdateService(window);
  stop = service.stop;
  await expect(service.check()).resolves.toBeUndefined();
  expect(mocks.dialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ message: "无法打开发布页" }),
  );
});

it("does not open the release page after the service stops while showing an error", async () => {
  mocks.fetch.mockResolvedValue(new Response("", { status: 429 }));
  const service = await startUpdateService(window);
  stop = service.stop;
  mocks.dialog.mockImplementationOnce(async () => {
    service.stop();
    return { response: 0 };
  });
  await service.check();
  expect(mocks.external).not.toHaveBeenCalled();
});
