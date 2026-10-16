import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEndNote } from "./endnote-discovery";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
it("finds custom names and packages without walking dependencies or symlink loops", async () => {
  const root = await mkdtemp(join(tmpdir(), "endnote-discovery-"));
  dirs.push(root);
  await writeFile(join(root, "Custom.ENL"), "");
  await mkdir(join(root, "Mac.enlp"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "Hidden.enl"), "");
  await symlink(root, join(root, "cycle"));
  const result = await discoverEndNote(
    [root, root],
    "win32",
    new AbortController().signal,
  );
  expect(result.candidates.map((c) => c.name)).toEqual([
    "Custom.ENL",
    "Mac.enlp",
  ]);
  expect(result.timedOut).toBe(false);
});
it("returns immediately for a cancelled search", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    await discoverEndNote(["/missing"], "win32", controller.signal),
  ).toEqual({ candidates: [], timedOut: false });
});

it("ends at ten seconds even when filesystem access never resolves", async () => {
  vi.useFakeTimers();
  const fs = await import("node:fs/promises");
  vi.mocked(fs.readdir).mockImplementation(() => new Promise(() => {}));
  let settled = false;
  const pending = discoverEndNote(
    ["/blocked"],
    "win32",
    new AbortController().signal,
  ).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(9999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ candidates: [], timedOut: true });
});
