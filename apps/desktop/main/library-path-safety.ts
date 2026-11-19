import { realpath } from "node:fs/promises";
import path from "node:path";

const libraryPathSafetyMessage =
  "书库不能放在应用安装目录内，也不能包含应用安装目录。应用与数据分开保存是保护数据的规范安全做法，可避免升级或卸载时误删书库。请选择独立位置，例如 E:\\NeoReadLibrary。";

export function pathsOverlap(
  library: string,
  installation: string,
  paths = path,
): boolean {
  const contains = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);
    return (
      relative === "" ||
      (!paths.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${paths.sep}`))
    );
  };
  return contains(library, installation) || contains(installation, library);
}

// Resolve the nearest existing ancestor too: migration creates a new child.
async function physicalPath(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await physicalPath(parent), path.basename(directory));
  }
}

export async function assertSafeLibraryPath(
  directory: string,
  installation: string | undefined,
): Promise<void> {
  if (!installation) return;
  // Check both spellings and resolved paths, including Windows junctions.
  if (
    pathsOverlap(path.resolve(directory), path.resolve(installation)) ||
    pathsOverlap(
      await physicalPath(directory),
      await physicalPath(installation),
    )
  ) {
    throw new Error(libraryPathSafetyMessage);
  }
}
