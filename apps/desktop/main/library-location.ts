import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  access,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
const execute = promisify(execFile);

export async function libraryDirectory(userData: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(userData, "library-location.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return join(userData, "library");
    throw error;
  }
  let directory: unknown;
  try {
    directory = JSON.parse(text)?.directory;
  } catch {}
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new Error("保存的书库位置无效，请检查 library-location.json。");
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    const database = await existingDatabase(directory);
    await access(database, constants.R_OK | constants.W_OK);
    if (!(await stat(database)).isFile()) throw new Error();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code || "INVALID_DATABASE";
    throw new Error(`无法访问已设置的书库（${code}）：${directory}`, { cause });
  }
  return directory;
}

/** Stdin EOF works on Windows too, unlike SIGTERM's forced termination there. */
export function stopLibraryServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error("本地服务未正常停止"));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("close", closed);
      child.removeListener("error", failed);
      child.stdin?.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const closed = (code: number | null) =>
      finish(code === 0 ? undefined : new Error("本地服务未正常停止"));
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("本地服务停止超时，未迁移书库")),
      30_000,
    );
    child.once("close", closed);
    child.once("error", failed);
    child.stdin?.once("error", failed);
    if (!child.stdin) finish(new Error("无法停止本地服务"));
    else child.stdin.end();
  });
}

export async function migrateLibrary(
  userData: string,
  source: string,
  destination: string,
  binary: string,
  stop: () => Promise<void>,
): Promise<void> {
  await stop();
  try {
    await execute(
      binary,
      ["--data", source, "--migrate-library", destination],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
  await saveLibraryDirectory(userData, destination);
}

export async function saveLibraryDirectory(
  userData: string,
  destination: string,
) {
  const temporary = join(userData, `library-location.${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ directory: destination }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, join(userData, "library-location.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Return to the default library under userData; the saved location is forgotten. */
export async function resetLibraryDirectory(userData: string) {
  await rm(join(userData, "library-location.json"), { force: true });
  return join(userData, "library");
}

export async function hasLibraryDatabase(directory: string) {
  try {
    return (await stat(await existingDatabase(directory))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function validateLibraryDirectory(
  directory: string,
  binary: string,
) {
  if (!isAbsolute(directory) || directory.includes("?"))
    throw new Error("请选择有效的绝对路径，书库路径不能包含 ?。");
  await access(directory, constants.R_OK | constants.W_OK);
  await access(
    await existingDatabase(directory),
    constants.R_OK | constants.W_OK,
  );
  try {
    await execute(binary, ["--data", directory, "--check-library"], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function existingDatabase(directory: string) {
  const current = join(directory, "neoread.sqlite");
  try {
    await stat(current);
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return join(directory, "reader.sqlite");
}
