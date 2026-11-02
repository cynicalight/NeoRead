import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  app: undefined as any,
  load: undefined as any,
  create: undefined as any,
  failure: vi.fn(),
}));
vi.mock("electron", () => ({
  get app() {
    return state.app;
  },
  dialog: { showErrorBox: state.failure },
}));
vi.mock("./startup-appearance-cache", () => ({
  readStartupAppearance: () => "dark",
}));
vi.mock("./startup-window", () => ({
  createStartupWindow: (...args: unknown[]) => state.create(...args),
}));
import { bootstrapDesktop } from "./bootstrap";
beforeEach(() => {
  state.app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => "/isolated",
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quit: vi.fn(),
  });
  state.load = vi.fn(async () => {});
  state.create = vi.fn(() => ({ load: state.load, dispose: vi.fn() }));
  state.failure.mockClear();
});
it("creates themed feedback before importing business code and replays early open events", async () => {
  let ready!: () => void;
  state.load.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const events: string[] = [];
  const adopt = vi.fn();
  const loadBusiness = vi.fn(() => {
    state.app.on("open-file", (_event: unknown, path: string) =>
      events.push(path),
    );
    return { adoptStartupWindow: adopt };
  });
  const running = bootstrapDesktop(loadBusiness);
  state.app.emit("open-file", { preventDefault: vi.fn() }, "example.pdf");
  await Promise.resolve();
  expect(state.create).toHaveBeenCalledWith(expect.any(Function), "dark");
  expect(loadBusiness).not.toHaveBeenCalled();
  ready();
  await running;
  expect(adopt).toHaveBeenCalledOnce();
  expect(events).toEqual(["example.pdf"]);
});
it("never starts business initialization after closing the loading window", async () => {
  let ready!: () => void;
  state.load.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const loadBusiness = vi.fn();
  const running = bootstrapDesktop(loadBusiness);
  await Promise.resolve();
  state.app.emit("before-quit");
  ready();
  await running;
  expect(loadBusiness).not.toHaveBeenCalled();
  expect(state.app.listenerCount("open-file")).toBe(0);
});
it("does not create a loading window for a second app instance", async () => {
  state.app.requestSingleInstanceLock = () => false;
  const loadBusiness = vi.fn();
  await bootstrapDesktop(loadBusiness);
  expect(state.app.quit).toHaveBeenCalledOnce();
  expect(state.create).not.toHaveBeenCalled();
  expect(loadBusiness).not.toHaveBeenCalled();
});
