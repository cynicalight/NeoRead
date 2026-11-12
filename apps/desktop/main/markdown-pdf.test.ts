import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  load: vi.fn(),
  print: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    destroyed = false;
    webContents = {
      id: mocks.windows.length + 1,
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
    loadFile = mocks.load;
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
  await expect(stat(mocks.load.mock.calls[0][0])).rejects.toMatchObject({
    code: "ENOENT",
  });
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
    await vi.waitFor(() => expect(mocks.print).toHaveBeenCalled());
    if (mode === "cancel") cancelMarkdownPDF("a");
    else await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.windows[0].destroy).toHaveBeenCalledOnce();
    finish();
    await pending;
    await expect(stat(mocks.load.mock.calls[0][0])).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
it("rejects malformed requests before opening a window", async () => {
  await expect(renderMarkdownPDF({}, "text")).rejects.toThrow(
    "Invalid print document",
  );
  expect(mocks.windows).toHaveLength(0);
});

it("loads large translated HTML from a temporary file and removes it", async () => {
  const html = "<p>" + "译".repeat(300_000) + "</p>";
  let file = "";
  mocks.load.mockImplementationOnce(async (path: string) => {
    file = path;
    expect(await readFile(path, "utf8")).toBe(html);
    const window = mocks.windows[0];
    const filter =
      window.webContents.session.webRequest.onBeforeRequest.mock.calls[0][0];
    const callback = vi.fn();
    filter(
      {
        url: pathToFileURL(path).href,
        resourceType: "mainFrame",
        webContentsId: window.webContents.id,
      },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    filter(
      {
        url: pathToFileURL(path).href,
        resourceType: "image",
        webContentsId: window.webContents.id,
      },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    filter(
      {
        url: pathToFileURL(path).href,
        resourceType: "mainFrame",
        webContentsId: 999,
      },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  });
  await renderMarkdownPDF("large", html);
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("removes temporary files when loading fails and allows retry", async () => {
  mocks.load.mockRejectedValueOnce(new Error("load failed"));
  await expect(renderMarkdownPDF("retry", "text")).rejects.toThrow(
    "load failed",
  );
  const file = mocks.load.mock.calls[0][0];
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(renderMarkdownPDF("retry", "text")).resolves.toEqual(
    new Uint8Array([1]),
  );
});

it("cleans up cancellation during temporary document preparation", async () => {
  const pending = renderMarkdownPDF("early-cancel", "text");
  cancelMarkdownPDF("early-cancel");
  await expect(pending).rejects.toThrow("Print request cancelled");
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.print).not.toHaveBeenCalled();
});
