import { lstat, readFile, readdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

// Keep both loader names, but store identical macOS libraries only once.
// Run on staging before electron-builder copies and signs the application.
export async function dedupeOnnxLibraries(directory) {
  let savedBytes = 0;
  const names = await readdir(directory);
  for (const name of names) {
    const match = /^libonnxruntime\.(\d+)\.\d+\.\d+\.dylib$/.exec(name);
    if (!match) continue;
    const target = `libonnxruntime.${match[1]}.dylib`;
    if (!names.includes(target)) continue;
    const sourcePath = join(directory, name);
    const targetPath = join(directory, target);
    const source = await lstat(sourcePath);
    const destination = await lstat(targetPath);
    // Existing upstream symlinks already save space; never create a link cycle.
    if (!source.isFile() || !destination.isFile()) continue;
    if (source.size !== destination.size) continue;
    if (!(await readFile(sourcePath)).equals(await readFile(targetPath)))
      continue;
    await unlink(sourcePath);
    await symlink(target, sourcePath);
    savedBytes += source.size;
  }
  return savedBytes;
}
