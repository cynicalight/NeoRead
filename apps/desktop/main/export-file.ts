import { dialog, type BrowserWindow } from "electron";
import { writeFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Resolve only after the chosen file is committed; cancellation saves nothing. */
export async function saveExportFile(
  parent: BrowserWindow,
  name: unknown,
  bytes: unknown,
): Promise<boolean> {
  if (
    typeof name !== "string" ||
    !name ||
    name !== basename(name) ||
    /[/\\\x00-\x1f]/.test(name) ||
    !(bytes instanceof Uint8Array)
  )
    throw new Error("Invalid export file");
  const result = await dialog.showSaveDialog(parent, { defaultPath: name });
  if (result.canceled || !result.filePath) return false;
  const temporary = join(
    dirname(result.filePath),
    `.neoread-export-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, result.filePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}
