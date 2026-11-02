import { execFile } from "node:child_process";
import { readFile, lstat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dialog, type BrowserWindow } from "electron";

import type { startDiagnosticService } from "./diagnostic-service";
import { serverSpawnDiagnostics } from "./server-spawn-diagnostics";
export class ReaderMigrationError extends Error {}

export interface ReaderMigration {
  status: "copying" | "verified" | "completed" | "not-needed";
  source?: string;
  library?: string;
  external?: boolean;
  legacyCleanup?: { status: "pending" | "kept" | "deleted" | "failed" };
}
async function run(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ReaderMigration> {
  let closed: Promise<void> | undefined;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { windowsHide: true, maxBuffer: 1024 * 1024, signal },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve(stdout);
        },
      );
      closed = new Promise((resolve) => child.once("close", () => resolve()));
    });
    const state = JSON.parse(stdout) as ReaderMigration;
    if (!state || !["completed", "not-needed"].includes(state.status))
      throw new Error("迁移尚未完成");
    return state;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message, {
      cause: error,
    });
  } finally {
    // execFile rejects on abort before the process exits. Keep the desktop alive
    // until close so a relaunch cannot race the child's migration/library locks.
    if (signal?.aborted) await closed;
  }
}
export async function migrateReaderData(
  binary: string,
  appData: string,
  userData: string,
  diagnostics?: ReturnType<typeof startDiagnosticService>,
  signal?: AbortSignal,
) {
  const started = Date.now();
  diagnostics?.record("migration.start");
  try {
    const state = await run(
      binary,
      [
        "--migrate-reader-data",
        join(appData, "Reader"),
        "--data",
        userData,
        ...(diagnostics
          ? [
              "--logs",
              diagnostics.directory,
              "--session",
              diagnostics.logs.sessionId,
            ]
          : []),
      ],
      signal,
    );
    diagnostics?.logs.record("desktop", {
      level: "info",
      event: "migration.finish",
      status: state.status,
      durationMs: Date.now() - started,
    });
    return state;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : error;
    diagnostics?.logs.record("desktop", {
      level: signal?.aborted ? "info" : "error",
      event: signal?.aborted ? "migration.cancelled" : "migration.failed",
      durationMs: Date.now() - started,
      ...(signal?.aborted
        ? { reasonCode: "desktop_quit" }
        : serverSpawnDiagnostics(binary, cause)),
    });
    throw new ReaderMigrationError((error as Error).message, { cause: error });
  }
}
/** Called only after the new library and renderer have opened successfully. */
export async function promptLegacyCleanup(
  window: BrowserWindow,
  binary: string,
  appData: string,
  userData: string,
  state: ReaderMigration,
) {
  if (state.status !== "completed" || state.legacyCleanup?.status !== "pending")
    return;
  const source = join(appData, "Reader");
  const { response } = await dialog.showMessageBox(window, {
    type: "info",
    title: "迁移已完成",
    message: "你的书库和配置已迁移到 NeoRead 并通过校验",
    detail: `建议卸载旧 Reader App，并清理旧阅读数据，释放磁盘空间。\n\n“立即清理”仅清理已迁移的旧书库和配置，缓存、日志和其他未迁移文件会保留。旧 Reader App 请手动卸载。\n\n旧数据目录：${source}${state.external ? "\n\n外置自定义书库的旧副本不会被删除。" : ""}`,
    buttons: ["稍后清理", "立即清理"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  try {
    await run(binary, [
      "--cleanup-reader-data",
      response === 1 ? "delete" : "keep",
      "--reader-data",
      source,
      "--data",
      userData,
    ]);
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: "warning",
      message: "旧数据清理未完成",
      detail: `${(error as Error).message}\n\nNeoRead 的迁移结果不受影响。请检查旧目录后手动处理：${source}`,
      buttons: ["知道了"],
      noLink: true,
    });
  }
}

/** Read only: never creates a journal, lock, destination or library. */
export async function detectReaderMigration(
  appData: string,
  userData: string,
): Promise<"required" | "resume" | "none" | "declined"> {
  try {
    const file = JSON.parse(
      await readFile(join(userData, "migrations.json"), "utf8"),
    );
    if (
      file.schemaVersion !== 1 ||
      !file.migrations ||
      typeof file.migrations !== "object" ||
      Array.isArray(file.migrations)
    )
      throw new Error("迁移记录损坏或版本不受支持");
    if (file.readerMigrationDecision === "declined") return "declined";
    const state = file.migrations["reader-to-neoread"];
    if (state !== undefined) {
      if (state?.status === "copying" || state?.status === "verified")
        return "resume";
      if (state?.status === "completed" || state?.status === "not-needed")
        return "none";
      throw new Error("无法识别迁移状态");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ReaderMigrationError("无法读取迁移记录，未改动旧数据", {
        cause: error,
      });
  }
  async function hasData(root: string) {
    for (const name of [
      "library-location.json",
      "library",
      "proxy-settings.json",
    ]) {
      try {
        await lstat(join(root, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }
  try {
    if (await hasData(userData)) return "none";
    return (await hasData(join(appData, "Reader"))) ? "required" : "none";
  } catch (error) {
    throw new ReaderMigrationError("无法检查旧 Reader 数据，未改动旧数据", {
      cause: error,
    });
  }
}

/** A user decision, separate from the journal's copy/verification progress. */
export async function declineReaderMigration(userData: string): Promise<void> {
  const target = join(userData, "migrations.json");
  let file;
  try {
    file = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = { schemaVersion: 1, migrations: {} };
  }
  if (
    file?.schemaVersion !== 1 ||
    !file.migrations ||
    typeof file.migrations !== "object" ||
    Array.isArray(file.migrations)
  )
    throw new Error("迁移记录损坏或版本不受支持");
  file.readerMigrationDecision = "declined";
  await mkdir(userData, { recursive: true });
  const temporary = join(userData, `.migrations.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
