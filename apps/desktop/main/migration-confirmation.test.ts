import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const state = vi.hoisted(() => ({
  window: undefined as any,
  ipc: undefined as any,
  stop: vi.fn(),
  fail: false,
}));
vi.mock("electron", () => {
  state.ipc = new EventEmitter();
  return {
    ipcMain: state.ipc,
    nativeTheme: { shouldUseDarkColors: false },
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "" },
        setWindowOpenHandler: vi.fn(),
      });
      show = vi.fn();
      constructor() {
        super();
        state.window = this;
      }
      async loadURL(url: string) {
        if (state.fail) throw new Error("load failed");
        this.webContents.mainFrame.url = url;
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
        this.emit("closed");
      }
    },
  };
});
vi.mock("./library-recovery-server", () => ({
  startLibraryRecoveryServer: async () => ({
    url: "http://127.0.0.1:1234",
    stop: state.stop,
  }),
}));
import { confirmReaderMigration } from "./migration-confirmation";
beforeEach(() => {
  state.fail = false;
  state.stop.mockClear();
  state.ipc.removeAllListeners();
});
const begin = (signal = new AbortController().signal) =>
  confirmReaderMigration("/assets", "/preload", false, signal);
it("accepts only the dedicated main frame and boolean values, then removes listeners", async () => {
  const result = begin();
  await vi.waitFor(() => expect(state.window.show).toHaveBeenCalled());
  const event = {
    sender: state.window.webContents,
    senderFrame: state.window.webContents.mainFrame,
  };
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  state.ipc.emit("neoread:migration-decision", { ...event, sender: {} }, true);
  state.ipc.emit(
    "neoread:migration-decision",
    { ...event, senderFrame: { url: event.senderFrame.url } },
    true,
  );
  state.ipc.emit("neoread:migration-decision", event, "yes");
  await Promise.resolve();
  expect(settled).toBe(false);
  state.ipc.emit("neoread:migration-decision", event, true);
  expect(await result).toBe(true);
  expect(state.window.isDestroyed()).toBe(true);
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.ipc.listenerCount("neoread:migration-decision")).toBe(0);
});
it.each(["close", "abort"])(
  "cancels and cleans resources on %s",
  async (action) => {
    const controller = new AbortController();
    const result = begin(controller.signal);
    await vi.waitFor(() => expect(state.window.show).toHaveBeenCalled());
    if (action === "close") state.window.destroy();
    else controller.abort();
    expect(await result).toBe(false);
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.ipc.listenerCount("neoread:migration-decision")).toBe(0);
  },
);
it("cleans resources when the page fails to load", async () => {
  state.fail = true;
  await expect(begin()).rejects.toThrow("load failed");
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.window.isDestroyed()).toBe(true);
  expect(state.ipc.listenerCount("neoread:migration-decision")).toBe(0);
});
