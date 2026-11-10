import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const saveDialog = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ dialog: { showSaveDialog: saveDialog } }));
import { saveExportFile } from "./export-file";
import type { BrowserWindow } from "electron";
const parent = {} as BrowserWindow;
const directories: string[] = [];
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "neoread-export-test-"));
  directories.push(dir);
  return dir;
};
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("commits the exact file bytes before reporting success", async () => {
  const dir = await directory();
  const file = join(dir, "file.pdf");
  saveDialog.mockResolvedValue({ filePath: file, canceled: false });
  expect(
    await saveExportFile(parent, "file.pdf", new Uint8Array([1, 2, 3])),
  ).toBe(true);
  expect([...(await readFile(file))]).toEqual([1, 2, 3]);
  expect(await readdir(dir)).toEqual(["file.pdf"]);
});
it("saves nothing when the dialog is cancelled", async () => {
  const dir = await directory();
  saveDialog.mockResolvedValue({
    filePath: join(dir, "file.md"),
    canceled: true,
  });
  expect(await saveExportFile(parent, "file.md", new Uint8Array([1]))).toBe(
    false,
  );
  expect(await readdir(dir)).toEqual([]);
});
it("cleans up a failed commit and preserves the existing destination", async () => {
  const dir = await directory();
  const file = join(dir, "file.md");
  await mkdir(file);
  saveDialog.mockResolvedValue({ filePath: file, canceled: false });
  await expect(
    saveExportFile(parent, "file.md", new Uint8Array([1])),
  ).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["file.md"]);
  expect(await readdir(file)).toEqual([]);
});
it.each(["../file.md", "a/b.md", "a\\b.md", "", "\u0000.md"])(
  "rejects invalid suggested filename %s",
  async (name) => {
    await expect(
      saveExportFile(parent, name, new Uint8Array([1])),
    ).rejects.toThrow("Invalid export file");
    expect(saveDialog).not.toHaveBeenCalled();
  },
);
it("rejects non-byte content before opening a dialog", async () => {
  await expect(saveExportFile(parent, "file.md", "content")).rejects.toThrow(
    "Invalid export file",
  );
  expect(saveDialog).not.toHaveBeenCalled();
});
