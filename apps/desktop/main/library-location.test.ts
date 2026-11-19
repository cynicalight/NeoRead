import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});
import {
  hasLibraryDatabase,
  libraryDirectory,
  migrateLibrary,
  resetLibraryDirectory,
  stopLibraryServer,
} from "./library-location";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "neoread-location-"));
  execute.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
it("uses the old location only when no configuration exists", async () => {
  expect(await libraryDirectory(directory)).toBe(join(directory, "library"));
  const moved = join(directory, "moved");
  await mkdir(moved);
  await writeFile(join(moved, "neoread.sqlite"), "db");
  await writeFile(
    join(directory, "library-location.json"),
    JSON.stringify({ directory: moved }),
  );
  expect(await libraryDirectory(directory)).toBe(moved);
  await rm(moved, { recursive: true });
  await expect(libraryDirectory(directory)).rejects.toThrow("书库");
});
it.each(["not json", "{}", '{"directory":"relative"}'])(
  "rejects invalid saved locations rather than creating a blank library",
  async (text) => {
    await writeFile(join(directory, "library-location.json"), text);
    await expect(libraryDirectory(directory)).rejects.toThrow();
  },
);
it("recovers from a deleted saved library by returning to the default location", async () => {
  await writeFile(
    join(directory, "library-location.json"),
    JSON.stringify({ directory: join(directory, "deleted") }),
  );
  await expect(libraryDirectory(directory)).rejects.toThrow("ENOENT");
  const fallback = await resetLibraryDirectory(directory);
  expect(fallback).toBe(join(directory, "library"));
  expect(await libraryDirectory(directory)).toBe(fallback);
  expect(await hasLibraryDatabase(fallback)).toBe(false);
  await mkdir(fallback);
  await writeFile(join(fallback, "reader.sqlite"), "db");
  expect(await hasLibraryDatabase(fallback)).toBe(true);
});
it("waits for shutdown and copies before switching the saved path", async () => {
  const order: string[] = [];
  const target = join(directory, "new");
  execute.mockImplementation(async () => {
    order.push("copy");
    expect(await libraryDirectory(directory)).toBe(join(directory, "library"));
    await mkdir(target);
    await writeFile(join(target, "neoread.sqlite"), "db");
  });
  await migrateLibrary(
    directory,
    join(directory, "library"),
    target,
    "/neoread-server",
    async () => {
      order.push("stop");
    },
  );
  expect(order).toEqual(["stop", "copy"]);
  expect(execute).toHaveBeenCalledWith(
    "/neoread-server",
    ["--data", join(directory, "library"), "--migrate-library", target],
    expect.objectContaining({ windowsHide: true }),
  );
  expect(await libraryDirectory(directory)).toBe(target);
});
it("keeps the saved location on copy failure and never copies after shutdown failure", async () => {
  const original = JSON.stringify({ directory: join(directory, "original") });
  await writeFile(join(directory, "library-location.json"), original);
  execute.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    migrateLibrary(directory, "source", "target", "binary", async () => {}),
  ).rejects.toThrow("disk full");
  expect(await readFile(join(directory, "library-location.json"), "utf8")).toBe(
    original,
  );
  execute.mockClear();
  await expect(
    migrateLibrary(directory, "source", "target", "binary", async () => {
      throw new Error("still running");
    }),
  ).rejects.toThrow("still running");
  expect(execute).not.toHaveBeenCalled();
});
it("uses stdin EOF and waits for the server to finish closing", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  let stopped = false;
  const promise = stopLibraryServer(child as unknown as ChildProcess).then(
    () => {
      stopped = true;
    },
  );
  expect(child.stdin.end).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(stopped).toBe(false);
  child.emit("close", 0, null);
  await promise;
  expect(stopped).toBe(true);
});
it("refuses to migrate if the server fails to shut down cleanly", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  const promise = stopLibraryServer(child as unknown as ChildProcess);
  const assertion = expect(promise).rejects.toThrow("停止");
  await vi.advanceTimersByTimeAsync(30000);
  await assertion;
  expect(child.listenerCount("close")).toBe(0);
});
