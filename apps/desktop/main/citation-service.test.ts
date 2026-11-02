import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  windows: [] as any[],
  loadFails: false,
}));
vi.mock("electron", () => ({
  ipcMain: Object.assign(new EventEmitter(), {
    handle: (name: string, handler: (...args: any[]) => any) => {
      if (state.handlers.has(name)) throw new Error("Duplicate IPC handler");
      state.handlers.set(name, handler);
    },
    removeHandler: (name: string) => state.handlers.delete(name),
  }),
  screen: {},
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      send: vi.fn(),
      setWindowOpenHandler() {},
    });
    setMenu() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL = vi.fn(async () => {
      if (state.loadFails) throw new Error("load failed");
    });
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
    constructor() {
      super();
      state.windows.push(this);
    }
  },
}));
import { ipcMain } from "electron";
import { startCitationService } from "./citation-service";
let stream: ReadableStreamDefaultController<Uint8Array>;
let service: ReturnType<typeof startCitationService>;
let request: ReturnType<typeof vi.fn>;
let record: ReturnType<typeof vi.fn<(event: string) => void>>;
const command = (id = "one") => ({
  type: "command",
  transaction: id,
  command: "addEditCitation",
  documentId: "document",
  client: "word-mac",
});
const send = (value: unknown) =>
  stream.enqueue(
    new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
  );
const sender = (window = state.windows.at(-1)) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});
const ready = () => ipcMain.emit("neoread:citation-ready", sender());
const tick = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
beforeEach(async () => {
  state.windows.length = 0;
  state.loadFails = false;
  state.handlers.clear();
  record = vi.fn();
  request = vi.fn(async (url: string) =>
    url.endsWith("/events")
      ? new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        )
      : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", request);
  service = startCitationService({
    url: "http://127.0.0.1:1234",
    token: "test",
    preload: "/preload.cjs",
    record,
  });
  await tick();
});
afterEach(() => {
  service.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("has no idle renderer, hands off once after ready, destroys it after completion and creates a fresh one", async () => {
  expect(state.windows).toHaveLength(0);
  send(command());
  await tick();
  const first = state.windows[0];
  expect(first.webContents.send).not.toHaveBeenCalled();
  ready();
  ready();
  expect(first.webContents.send).toHaveBeenCalledExactlyOnceWith(
    "neoread:citation-event",
    command(),
  );
  expect(() =>
    state.handlers.get("neoread:citation-complete")!(
      { sender: {}, senderFrame: {} },
      "one",
      "",
    ),
  ).toThrow("Invalid sender");
  await state.handlers.get("neoread:citation-complete")!(sender(), "one", "");
  await tick();
  expect(first.destroyed).toBe(true);
  expect(request.mock.calls.at(-1)?.[0]).toContain("/one/complete");
  expect(state.handlers.has("neoread:citation-visible")).toBe(false);
  send(command("two"));
  await tick();
  ready();
  expect(state.windows).toHaveLength(2);
  expect(state.windows[1].webContents.send).toHaveBeenCalledWith(
    "neoread:citation-event",
    command("two"),
  );
});
it("cancels a native close or renderer crash and permits the next command", async () => {
  send(command());
  await tick();
  state.windows[0].destroy();
  await tick();
  expect(request.mock.calls.at(-1)?.[0]).toContain("/one/complete");
  send(command("two"));
  await tick();
  state.windows[1].webContents.emit("render-process-gone");
  await tick();
  expect(state.windows[1].destroyed).toBe(true);
  expect(request.mock.calls.at(-1)?.[0]).toContain("/two/complete");
});
it("does not deliver a command aborted while its renderer loads", async () => {
  send(command());
  await tick();
  const original = state.windows[0];
  send({ type: "aborted", transaction: "one" });
  await tick();
  ipcMain.emit("neoread:citation-ready", sender(original));
  expect(original.destroyed).toBe(true);
  expect(original.webContents.send).not.toHaveBeenCalled();
});
it("destroys the active renderer when the Word event stream disconnects", async () => {
  send(command());
  await tick();
  ready();
  stream.close();
  await tick();
  expect(state.windows[0].destroyed).toBe(true);
});
it("times out a renderer that never becomes ready instead of leaving Word waiting", async () => {
  vi.useFakeTimers();
  send(command());
  await vi.advanceTimersByTimeAsync(15001);
  expect(state.windows[0].destroyed).toBe(true);
  expect(request.mock.calls.at(-1)?.[0]).toContain("/one/complete");
  expect(record).toHaveBeenCalledWith("citation.window_timeout");
});
it("stops while loading and releases listeners without reopening", async () => {
  send(command());
  await tick();
  service.stop();
  ipcMain.emit("neoread:citation-ready", sender());
  expect(state.windows[0].destroyed).toBe(true);
  expect(state.handlers.size).toBe(0);
  expect(state.windows[0].webContents.send).not.toHaveBeenCalled();
});

it("cancels a failed page load and creates a new renderer on retry", async () => {
  state.loadFails = true;
  send(command());
  await tick();
  expect(state.windows[0].destroyed).toBe(true);
  expect(record).toHaveBeenCalledWith("citation.window_failed");
  state.loadFails = false;
  send(command("two"));
  await tick();
  ready();
  expect(state.windows[1].destroyed).toBe(false);
});
it("keeps one renderer for repeated commands and forwards focus only after ready", async () => {
  send(command());
  send(command());
  send({ type: "focus" });
  await tick();
  expect(state.windows).toHaveLength(1);
  expect(state.windows[0].webContents.send).not.toHaveBeenCalled();
  ready();
  send({ type: "focus" });
  await tick();
  expect(state.windows[0].webContents.send).toHaveBeenLastCalledWith(
    "neoread:citation-event",
    { type: "focus" },
  );
});
