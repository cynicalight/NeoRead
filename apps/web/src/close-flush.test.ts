// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ value: false }));
vi.mock("./paper-note-state", () => ({
  flushPaperNotes: vi.fn(async () => void calls.push("notes")),
  hasPendingPaperNotes: () => pending.value,
}));
const calls = vi.hoisted(() => [] as string[]);
vi.mock("./progress", () => ({
  flushProgress: vi.fn(async () => void calls.push("progress")),
}));
vi.mock("@neoread/api", () => ({
  api: {
    saveSettings: vi.fn(async () => void calls.push("settings")),
  },
}));
vi.mock("./store", () => ({
  useReaderStore: { getState: () => ({ theme: { mode: "light" } }) },
}));
import { installCloseFlush } from "./close-flush";

afterEach(() => {
  calls.length = 0;
  pending.value = false;
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: undefined,
  });
});

it("answers the desktop close request without any React tree", async () => {
  let close: (() => Promise<void>) | undefined;
  const remove = vi.fn();
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: {
      onBeforeClose: (callback: () => Promise<void>) => {
        close = callback;
        return remove;
      },
    },
  });
  const uninstall = installCloseFlush();
  await close!();
  expect(calls).toEqual(["progress", "notes", "settings", "notes"]);
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toEqual([
    "progress",
    "notes",
    "settings",
    "notes",
    "progress",
    "notes",
  ]);
  uninstall();
  expect(remove).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toHaveLength(6);
});

it("guards browser unload only while notes are unsaved and cleans up the listener", () => {
  const uninstall = installCloseFlush();
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  pending.value = true;
  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  uninstall();
  const after = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

it("leaves Electron close decisions to the existing native flow", () => {
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: { onBeforeClose: vi.fn() },
  });
  pending.value = true;
  const uninstall = installCloseFlush();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  uninstall();
});

it("waits for note writes and rejects the native close handshake on a save error", async () => {
  const { flushPaperNotes } = await import("./paper-note-state");
  let close!: () => Promise<void>;
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: {
      onBeforeClose: (callback: () => Promise<void>) => {
        close = callback;
      },
    },
  });
  const uninstall = installCloseFlush();
  let resolve!: () => void;
  vi.mocked(flushPaperNotes).mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const closing = close();
  await vi.waitFor(() => expect(calls).toContain("settings"));
  resolve();
  await closing;
  expect(calls).toContain("settings");
  vi.mocked(flushPaperNotes).mockRejectedValueOnce(new Error("note offline"));
  calls.length = 0;
  await expect(close()).rejects.toThrow("note offline");
  expect(calls).toContain("settings");
  uninstall();
});

it("starts saving when the browser becomes hidden and removes the listener", () => {
  const uninstall = installCloseFlush();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(calls).toContain("notes");
  uninstall();
  calls.length = 0;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(calls).toEqual([]);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
