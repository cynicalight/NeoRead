import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  dialog: vi.fn(),
  child: undefined as import("node:events").EventEmitter | undefined,
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    execFile: (...args: unknown[]) => {
      mocks.child = new EventEmitter();
      mocks.exec(...args);
      return mocks.child;
    },
  };
});
vi.mock("electron", () => ({
  dialog: { showMessageBox: (...args: unknown[]) => mocks.dialog(...args) },
}));
import {
  migrateReaderData,
  promptLegacyCleanup,
  type ReaderMigration,
} from "./legacy-data";
const completed: ReaderMigration = {
  status: "completed",
  external: true,
  legacyCleanup: { status: "pending" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.exec.mockImplementation((_binary, _args, _options, callback) =>
    callback(null, JSON.stringify(completed), ""),
  );
  mocks.dialog.mockResolvedValue({ response: 0 });
});
it("skips cleanup UI for fresh installs and completed choices", async () => {
  for (const state of [
    { status: "not-needed" },
    { ...completed, legacyCleanup: { status: "kept" } },
    { ...completed, legacyCleanup: { status: "failed" } },
  ] as ReaderMigration[])
    await promptLegacyCleanup(
      {} as never,
      "/bin/server",
      "/data",
      "/data/NeoRead",
      state,
    );
  expect(mocks.dialog).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});
it("uses the fixed source directory and propagates migration errors", async () => {
  mocks.exec.mockImplementation((_b, _a, _o, cb) =>
    cb(new Error("failed"), "", "旧书库仍在使用中"),
  );
  await expect(
    migrateReaderData("/bin/server", "/data", "/data/NeoRead"),
  ).rejects.toThrow("旧书库仍在使用中");
  expect(mocks.exec.mock.calls[0][1]).toEqual([
    "--migrate-reader-data",
    join("/data", "Reader"),
    "--data",
    "/data/NeoRead",
  ]);
});
it("recommends cleanup, but records keeping data when postponed", async () => {
  await promptLegacyCleanup(
    {} as never,
    "/bin/server",
    "/data",
    "/data/NeoRead",
    completed,
  );
  expect(mocks.dialog.mock.calls[0][1]).toMatchObject({
    buttons: ["稍后清理", "立即清理"],
    defaultId: 1,
    cancelId: 0,
  });
  expect(mocks.dialog.mock.calls[0][1].detail).toContain(
    "其他未迁移文件会保留",
  );
  expect(mocks.dialog.mock.calls[0][1].detail).toContain("外置自定义书库");
  expect(mocks.exec.mock.calls[0][1]).toContain("keep");
});
it("deletes only after the user chooses it and reports failures", async () => {
  mocks.dialog.mockResolvedValueOnce({ response: 1 });
  mocks.exec.mockImplementation((_b, _a, _o, cb) =>
    cb(new Error("旧数据发生变化"), "", ""),
  );
  await promptLegacyCleanup(
    {} as never,
    "/bin/server",
    "/data",
    "/data/NeoRead",
    completed,
  );
  expect(mocks.exec.mock.calls[0][1]).toContain("delete");
  expect(mocks.dialog.mock.calls[1][1].detail).toContain("旧数据发生变化");
});

it("waits for child close on cancellation and records one safe cancellation event", async () => {
  const controller = new AbortController();
  mocks.exec.mockImplementation((_b, _a, options, callback) => {
    options.signal.addEventListener("abort", () =>
      callback(new Error("PRIVATE_CANCEL_SENTINEL"), "", ""),
    );
  });
  const record = vi.fn();
  const diagnostics = {
    directory: "/logs",
    record: vi.fn(),
    logs: { sessionId: "session", record },
  };
  let settled = false;
  const migration = migrateReaderData(
    "/bin/server",
    "/data",
    "/data/NeoRead",
    diagnostics as never,
    controller.signal,
  ).catch((error) => {
    settled = true;
    return error;
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  mocks.child!.emit("close", null, "SIGTERM");
  expect(await migration).toBeInstanceOf(Error);
  expect(record).toHaveBeenCalledExactlyOnceWith(
    "desktop",
    expect.objectContaining({
      level: "info",
      event: "migration.cancelled",
      reasonCode: "desktop_quit",
    }),
  );
  expect(JSON.stringify(record.mock.calls)).not.toContain(
    "PRIVATE_CANCEL_SENTINEL",
  );
});
