// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { installCloseFlush } from "./close-flush";
import { getPaperNote, hasPendingPaperNotes } from "./paper-note-state";

vi.mock("@neoread/api", () => ({
  api: {
    documentNote: vi.fn(async () => ({ body: "", updatedAt: "" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({
      body,
      updatedAt: "",
    })),
    saveSettings: vi.fn(async () => {}),
  },
}));
vi.mock("./progress", () => ({ flushProgress: vi.fn(async () => {}) }));
vi.mock("./store", () => ({
  useReaderStore: { getState: () => ({ theme: { mode: "light" } }) },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: undefined,
  });
});

it("saves edits made while settings are saving, including another document edited during the final note flush", async () => {
  vi.useFakeTimers();
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
  const a = getPaperNote("close-late-a"),
    b = getPaperNote("close-late-b");
  const releaseA = a.subscribe(() => {}),
    releaseB = b.subscribe(() => {});
  await Promise.all([a.load(), b.load()]);
  let settingsStarted!: () => void, finishSettings!: () => void;
  const started = new Promise<void>((resolve) => {
    settingsStarted = resolve;
  });
  vi.mocked(api.saveSettings).mockImplementationOnce((theme) => {
    settingsStarted();
    return new Promise<typeof theme>((resolve) => {
      finishSettings = () => resolve(theme);
    });
  });
  let finishA!: (note: { body: string; updatedAt: string }) => void;
  vi.mocked(api.saveDocumentNote).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  let closed = false;
  const closing = close().then(() => {
    closed = true;
  });
  await started;
  a.edit("typed during settings save");
  finishSettings();
  // Drain promises without firing the five-second autosave timer.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(closed).toBe(false);
  expect(api.saveDocumentNote).toHaveBeenCalledWith(
    a.id,
    "typed during settings save",
  );
  b.edit("another document edited during note save");
  finishA({ body: "typed during settings save", updatedAt: "" });
  await closing;
  expect(api.saveDocumentNote).toHaveBeenCalledWith(
    b.id,
    "another document edited during note save",
  );
  expect(hasPendingPaperNotes()).toBe(false);
  releaseA();
  releaseB();
  uninstall();
});

it("discards a failed note, waits for other writes, and acknowledges close with a warning", async () => {
  vi.useFakeTimers();
  let close!: () => Promise<unknown>;
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: {
      onBeforeClose: (callback: () => Promise<unknown>) => {
        close = callback;
      },
    },
  });
  const uninstall = installCloseFlush();
  const a = getPaperNote("close-discard-a"),
    b = getPaperNote("close-discard-b");
  const releaseA = a.subscribe(() => {}),
    releaseB = b.subscribe(() => {});
  await Promise.all([a.load(), b.load()]);
  a.edit("discard this");
  b.edit("save this");
  let finish!: (result: { body: string; updatedAt: string }) => void;
  vi.mocked(api.saveDocumentNote)
    .mockRejectedValueOnce(new Error("disk error"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  let closed = false;
  const closing = close().then((result) => {
    closed = true;
    return result;
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(closed).toBe(false);
  finish({ body: "save this", updatedAt: "" });
  await expect(closing).resolves.toEqual({ noteSaveDiscarded: true });
  expect(a.getSnapshot().body).toBe("");
  expect(b.getSnapshot().body).toBe("save this");
  expect(hasPendingPaperNotes()).toBe(false);
  await vi.advanceTimersByTimeAsync(15000);
  expect(api.saveDocumentNote).toHaveBeenCalledTimes(2);
  releaseA();
  releaseB();
  uninstall();
});
