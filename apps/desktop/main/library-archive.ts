import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { dirname, basename, relative, sep, isAbsolute } from "node:path";
import { mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import type { LibraryArchiveOptions } from "../../../packages/neoread-core/src/library-archive";
const execute = promisify(execFile);

export async function prepareLibraryArchive(
  url: string,
  token: string,
  file: string,
  destination: string,
  merge: boolean,
  signal: AbortSignal,
) {
  const response = await fetch(url + "/api/library/archive/import", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file, destination, merge }),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "书库导入失败");
  }
}

export async function downloadLibraryArchive(
  url: string,
  token: string,
  options: LibraryArchiveOptions,
  destination: string,
  source: string,
  signal: AbortSignal,
) {
  const sourceRoot = await realpath(source),
    parent = await realpath(dirname(destination));
  const inside = relative(sourceRoot, join(parent, basename(destination)));
  if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep))
    throw new Error("请选择书库目录之外的压缩包保存位置。");
  const response = await fetch(url + "/api/library/archive/export", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      library: options.library,
      folder: options.folder,
      smartCategory: options.smartCategory,
    }),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "书库导出失败");
  }
  if (
    !response.body ||
    !response.headers.get("Content-Type")?.startsWith("application/zip")
  )
    throw new Error("书库压缩包响应无效");
  const directory = await mkdtemp(join(parent, ".neoread-export-"));
  const temporary = join(directory, "library.zip");
  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      let offset = 0;
      while (offset < value.length) {
        const result = await file.write(value, offset, value.length - offset);
        if (!result.bytesWritten) throw new Error("无法保存书库压缩包");
        offset += result.bytesWritten;
      }
    }
    await file.sync();
    await file.close();
    signal.throwIfAborted();
    await rename(temporary, destination);
  } finally {
    await reader.cancel().catch(() => {});
    await file?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

export type LibraryArchiveOperation =
  | { kind: "export"; file: string; options: LibraryArchiveOptions }
  | { kind: "import"; file: string; merge: boolean };

/** The caller has flushed the renderer and stopped its library server. */
export async function transferLibraryArchive(
  binary: string,
  source: string,
  destination: string,
  operation: LibraryArchiveOperation,
  userData: string,
) {
  const args = ["--data", source, "--logs", join(userData, "logs")];
  if (operation.kind === "export") {
    args.push("--export-library", operation.file);
    if (operation.options.library)
      args.push("--archive-library", operation.options.library);
    if (operation.options.folder)
      args.push("--archive-folder", operation.options.folder);
    if (operation.options.smartCategory)
      args.push("--archive-smart", operation.options.smartCategory);
  } else {
    args.push(
      "--import-library-archive",
      operation.file,
      "--archive-destination",
      destination,
    );
    if (operation.merge) args.push("--archive-merge");
  }
  try {
    await execute(binary, args, { windowsHide: true, maxBuffer: 64 * 1024 });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
