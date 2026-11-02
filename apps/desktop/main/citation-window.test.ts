import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  options: {} as Record<string, unknown>,
}));
vi.mock("electron", () => ({
  app: { once: vi.fn(), focus: vi.fn() },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
    }),
  },
  ipcMain: {
    removeHandler: (name: string) => state.handlers.delete(name),
    handle: (name: string, handler: (...args: any[]) => unknown) =>
      state.handlers.set(name, handler),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });
    hide = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn();
    isVisible = () => false;
    getBounds = () => ({ x: 0, y: 0, width: 740, height: 740 });
    setMenu = vi.fn();
    loadURL = vi.fn(async () => {});
    constructor(options: Record<string, unknown>) {
      super();
      state.options = options;
    }
  },
}));
import { app } from "electron";
import { createCitationWindow } from "./citation-window";
beforeEach(() => state.handlers.clear());
it("starts hidden until measured, validates its main frame and releases IPC on close", async () => {
  const window = await createCitationWindow({
    url: "http://127.0.0.1:1234",
    token: "test",
    preload: "/preload.cjs",
    onFailure: vi.fn(),
  });
  expect(state.options).toMatchObject({ show: false, frame: false });
  expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
    visibleOnFullScreen: true,
    ...(process.platform === "darwin" ? { skipTransformProcessType: true } : {}),
  });
  expect(window.loadURL).toHaveBeenCalledWith(
    "http://127.0.0.1:1234/?citationWindow=1#token=test",
  );
  const visible = state.handlers.get("neoread:citation-visible")!;
  expect(() => visible({ sender: {}, senderFrame: {} }, true)).toThrow(
    "Invalid sender",
  );
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const size = state.handlers.get("neoread:citation-size")!;
  expect(() => size(event, "wide", 10)).toThrow("Invalid size");
  size(event, 480, 400.4);
  expect(window.setBounds).toHaveBeenCalledWith({
    x: 480,
    y: 262,
    width: 480,
    height: 401,
  });
  visible(event, true);
  expect(window.show).toHaveBeenCalledOnce();
  // Showing must not activate NeoRead and bring the library forward.
  expect(app.focus).not.toHaveBeenCalled();
  const preventDefault = vi.fn();
  window.emit("close", { preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  window.emit("closed");
  expect(state.handlers.size).toBe(0);
});
