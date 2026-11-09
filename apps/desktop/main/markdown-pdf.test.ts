import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  load: vi.fn(),
  print: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    destroyed = false;
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      },
      printToPDF: mocks.print,
    };
    constructor(readonly options: unknown) {
      mocks.windows.push(this);
    }
    loadURL = mocks.load;
    isDestroyed() {
      return this.destroyed;
    }
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
  },
}));
import { renderMarkdownPDF, cancelMarkdownPDF } from "./markdown-pdf";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows.length = 0;
  mocks.load.mockResolvedValue(undefined);
  mocks.print.mockResolvedValue(new Uint8Array([1]));
});
afterEach(() => vi.useRealTimers());
it("prints in an isolated window and destroys it after success", async () => {
  await expect(renderMarkdownPDF("a", "<p>译文</p>")).resolves.toEqual(
    new Uint8Array([1]),
  );
  const window = mocks.windows[0];
  expect(window.options.webPreferences).toMatchObject({
    javascript: false,
    sandbox: true,
    nodeIntegration: false,
  });
  expect(window.options.webPreferences).not.toHaveProperty("preload");
  expect(window.destroy).toHaveBeenCalledOnce();
  const filter =
    window.webContents.session.webRequest.onBeforeRequest.mock.calls[0][0];
  const allow = vi.fn();
  filter({ url: "data:image/png;base64,aW1hZ2U=" }, allow);
  expect(allow).toHaveBeenCalledWith({ cancel: false });
  for (const url of [
    "data:text/javascript;base64,YWxlcnQoMSk=",
    "https://example.com",
    "file:///private",
    "http://127.0.0.1:1234/",
  ]) {
    const callback = vi.fn();
    filter({ url }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  }
});
it("cleans up when native printing fails", async () => {
  mocks.print.mockRejectedValueOnce(new Error("print failed"));
  await expect(renderMarkdownPDF("a", "text")).rejects.toThrow("print failed");
  expect(mocks.windows[0].destroy).toHaveBeenCalledOnce();
});
it.each(["cancel", "timeout"])(
  "destroys the active window on %s",
  async (mode) => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.print.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = renderMarkdownPDF("a", "text");
    await Promise.resolve();
    if (mode === "cancel") cancelMarkdownPDF("a");
    else await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.windows[0].destroy).toHaveBeenCalledOnce();
    finish();
    await pending;
  },
);
it("rejects malformed requests before opening a window", async () => {
  await expect(renderMarkdownPDF({}, "text")).rejects.toThrow(
    "Invalid print document",
  );
  expect(mocks.windows).toHaveLength(0);
});
