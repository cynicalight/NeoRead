// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  runLibraryArchive,
  switchImportedLibrary,
  useLibraryArchiveTask,
} from "./library-archive-task";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() =>
  useLibraryArchiveTask.setState({
    kind: null,
    phase: "idle",
    foreground: false,
    error: "",
    entry: undefined,
  }),
);
afterEach(() => vi.unstubAllGlobals());
it("keeps background import online until the user chooses to switch, and retains a prepared library after switch failure", async () => {
  let finish!: (value: { id: string; name: string; directory: string }) => void;
  const switchLibrary = vi
    .fn()
    .mockRejectedValueOnce(new Error("save failed"))
    .mockResolvedValue(true);
  vi.stubGlobal("neoreadDesktop", { switchLibrary });
  const task = runLibraryArchive("import", (started) => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  useLibraryArchiveTask.setState({ foreground: false });
  finish({ id: "new", name: "研究", directory: "/new" });
  await task;
  expect(useLibraryArchiveTask.getState().phase).toBe("ready");
  expect(switchLibrary).not.toHaveBeenCalled();
  await switchImportedLibrary();
  expect(useLibraryArchiveTask.getState()).toMatchObject({
    phase: "ready",
    error: "save failed",
    entry: { id: "new" },
  });
  await switchImportedLibrary();
  expect(switchLibrary).toHaveBeenCalledTimes(2);
  expect(useLibraryArchiveTask.getState().phase).toBe("idle");
});
it("keeps exports running after foreground dismissal and reports completion", async () => {
  let finish!: (value: boolean) => void;
  const task = runLibraryArchive("export", (started) => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  useLibraryArchiveTask.setState({ foreground: false });
  const duplicate = vi.fn(async () => true);
  await runLibraryArchive("export", duplicate);
  expect(duplicate).not.toHaveBeenCalled();
  expect(useLibraryArchiveTask.getState().phase).toBe("running");
  finish(true);
  await task;
  expect(useLibraryArchiveTask.getState().phase).toBe("idle");
});

it("waits for native path selection before showing a running task, and leaves cancellation idle", async () => {
  let start!: () => void, finish!: (value: boolean) => void;
  const task = runLibraryArchive("export", (started) => {
    start = started;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  expect(useLibraryArchiveTask.getState().phase).toBe("selecting");
  start();
  expect(useLibraryArchiveTask.getState().phase).toBe("running");
  finish(true);
  await task;
  expect(useLibraryArchiveTask.getState().phase).toBe("idle");
  await runLibraryArchive("import", async () => false);
  expect(useLibraryArchiveTask.getState().phase).toBe("idle");
});
