import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { startupAnimationScript } from "./startup-animation";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  options: {} as any,
  window: undefined as any,
}));
vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: true },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => {}),
    });
    loadURL = vi.fn(async () => {
      this.emit("ready-to-show");
    });
    destroy = vi.fn(() => {
      this.emit("closed");
    });
    isDestroyed = () => false;
    constructor(options: unknown) {
      super();
      state.options = options;
      state.window = this;
    }
  },
}));
import { createStartupWindow } from "./startup-window";
afterEach(() => vi.useRealTimers());
it("keeps the first ready frame visible for at least 500ms, but never delays cancellation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const startup = createStartupWindow(vi.fn(), "dark");
  await startup.load();
  let finished = false;
  const wait = startup.waitForMinimumDisplay().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(499);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await wait;
  expect(finished).toBe(true);
  startup.dispose();
  const next = createStartupWindow(vi.fn());
  await next.load();
  const pending = next.waitForMinimumDisplay();
  await Promise.resolve();
  next.dispose();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it("uses the saved appearance rather than the opposite OS theme", async () => {
  const light = createStartupWindow(vi.fn(), "light");
  await light.load();
  expect(state.options.backgroundColor).toBe("#ffffff");
  expect(decodeURIComponent(state.window.loadURL.mock.calls[0][0])).toContain(
    'data-startup-theme="light"',
  );
  light.dispose();
  const dark = createStartupWindow(vi.fn(), "dark");
  await dark.load();
  expect(state.options.backgroundColor).toBe("#211e21");
  expect(decodeURIComponent(state.window.loadURL.mock.calls[0][0])).toContain(
    'data-startup-theme="dark"',
  );
  dark.dispose();
});
it("does not treat load completion as the first ready frame and loads only once", async () => {
  const startup = createStartupWindow(vi.fn());
  state.window.loadURL.mockImplementation(async () => {});
  let ready = false;
  const loading = startup.load().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  state.window.emit("ready-to-show");
  await loading;
  await startup.load();
  expect(state.window.loadURL).toHaveBeenCalledOnce();
  startup.dispose();
});
it("starts the 500ms interval only after content paint, including delayed paints", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const startup = createStartupWindow(vi.fn());
  let paint!: () => void;
  state.window.webContents.executeJavaScript.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        paint = resolve;
      }),
  );
  let loaded = false;
  const load = startup.load().then(() => {
    loaded = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(loaded).toBe(false);
  paint();
  await load;
  let switched = false;
  const minimum = startup.waitForMinimumDisplay().then(() => {
    switched = true;
  });
  await vi.advanceTimersByTimeAsync(499);
  expect(switched).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await minimum;
  expect(switched).toBe(true);
  startup.dispose();
});
it("cancels first-paint waiting when the window is closed", async () => {
  const startup = createStartupWindow(vi.fn());
  state.window.webContents.executeJavaScript.mockImplementation(
    () => new Promise(() => {}),
  );
  const loading = startup.load();
  const rejected = expect(loading).rejects.toThrow("Startup window closed");
  startup.dispose();
  await rejected;
});
it("loads local feedback without a server or preload and preserves close cancellation", async () => {
  const quit = vi.fn();
  const startup = createStartupWindow(quit);
  await startup.load();
  expect(state.options.webPreferences).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  const html = decodeURIComponent(state.window.loadURL.mock.calls[0][0]);
  expect(html).toContain("正在启动 NeoRead");
  const hash = createHash("sha256")
    .update(startupAnimationScript)
    .digest("base64");
  expect(html).toContain(`script-src 'sha256-${hash}'`);
  expect(html).not.toContain("script-src 'unsafe-inline'");
  expect(html).toContain("prefers-reduced-motion");
  state.window.emit("close");
  expect(quit).toHaveBeenCalledOnce();
  startup.dispose();
  expect(state.window.destroy).toHaveBeenCalledOnce();
  state.window.emit("close");
  expect(quit).toHaveBeenCalledOnce();
});
