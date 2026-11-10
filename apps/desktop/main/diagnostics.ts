import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  constants,
  readSync,
  openSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import {
  redact,
  redactLog,
  type DiagnosticEvent,
} from "../../../packages/neoread-core/src/diagnostics";

export const retention = {
  days: 7,
  totalBytes: 100 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
};
const logName =
  /^(desktop|server|renderer|server-stderr)-[A-Za-z0-9_.-]+\.(jsonl|log)$/;

export class DiagnosticLogs {
  readonly sessionId = randomUUID();
  droppedWrites = 0;
  private sequence = new Map<string, number>();
  private lastPrune = 0;
  private fallback: string[] = [];
  constructor(
    public directory: string,
    readonly secrets: string[] = [],
  ) {}
  record(
    source: "desktop" | "renderer" | "server-stderr",
    event: DiagnosticEvent | Record<string, unknown>,
  ) {
    const data =
      JSON.stringify(
        redact(
          {
            ...event,
            timestamp: new Date().toISOString(),
            source,
            sessionId: this.sessionId,
          },
          this.secrets,
        ),
      ) + "\n";
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      let sequence = this.sequence.get(source) || 1;
      const name = () =>
        join(
          this.directory,
          `${source}-${this.sessionId}-${String(sequence).padStart(4, "0")}.jsonl`,
        );
      const rotated =
        this.regularSize(name()) + Buffer.byteLength(data) >
        retention.fileBytes;
      if (rotated) sequence++;
      this.sequence.set(source, sequence);
      // Refuse symlink log targets even when another local process replaces one.
      const fd = openSync(
        name(),
        constants.O_CREAT |
          constants.O_APPEND |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW || 0),
        0o600,
      );
      try {
        appendFileSync(fd, data);
      } finally {
        closeSync(fd);
      }
      if (rotated || Date.now() - this.lastPrune > 60_000) {
        this.prune();
        this.lastPrune = Date.now();
      }
    } catch {
      this.droppedWrites++;
      this.fallback.push(data);
      // Disk failure must not prevent saving reading data. Preserve a bounded tail.
      while (this.fallback.length > 200) this.fallback.shift();
    }
  }
  private regularSize(path: string) {
    try {
      const info = lstatSync(path);
      return info.isFile() ? info.size : 0;
    } catch {
      return 0;
    }
  }
  prune() {
    const files = readdirSync(this.directory)
      .filter((name) => logName.test(name))
      .flatMap((name) => {
        try {
          const info = lstatSync(join(this.directory, name));
          return info.isFile()
            ? [{ name, size: info.size, modified: info.mtimeMs }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.modified - b.modified);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files)
      if (
        Date.now() - f.modified > retention.days * 86400_000 ||
        total > retention.totalBytes
      ) {
        try {
          unlinkSync(join(this.directory, f.name));
          total -= f.size;
        } catch {
          /* Report unreadable files during export. */
        }
      }
  }

  /** Does not call the sidecar, read its DB, or trust renderer-supplied paths. */
  async export(
    path: string,
    library: string | undefined,
    environment: unknown,
    settings: unknown,
    additionalDirectories: string[] = [],
  ) {
    const zip = new ZipFile();
    const files: Array<{ name: string; bytes: number; modified: string }> = [];
    const missing: string[] = [];
    const result = pipeline(
      zip.outputStream,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    // Handle a destination failure immediately, while files are being enumerated.
    void result.catch(() => {});
    const addJSON = (name: string, value: unknown) =>
      zip.addBuffer(
        Buffer.from(JSON.stringify(redact(value, this.secrets), null, 2)),
        name,
      );
    const addDirectory = (
      directory: string,
      prefix: string,
      legacy = false,
    ) => {
      try {
        if (!lstatSync(directory).isDirectory()) {
          missing.push(`${prefix}: unsafe directory`);
          return;
        }
        for (const name of readdirSync(directory).sort()) {
          if (!(legacy ? /^[A-Za-z0-9_.-]+\.txt$/ : logName).test(name))
            continue;
          const archiveName = prefix + name;
          try {
            const location = join(directory, name);
            if (!lstatSync(location).isFile()) {
              missing.push(`${archiveName}: symlink or non-file skipped`);
              continue;
            }
            const snapshot = lstatSync(location);
            if (snapshot.size > 32 * 1024 * 1024)
              throw new Error("oversized file");
            zip.addReadStreamLazy(
              archiveName,
              { mtime: snapshot.mtime, mode: 0o600 },
              (callback) => {
                try {
                  if (!lstatSync(directory).isDirectory())
                    throw new Error("unsafe directory");
                  const fd = openSync(
                    location,
                    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
                  );
                  let data: Buffer;
                  try {
                    if (!fstatSync(fd).isFile())
                      throw new Error("not a regular file");
                    data = Buffer.alloc(snapshot.size);
                    let bytes = 0;
                    while (bytes < data.length) {
                      const read = readSync(
                        fd,
                        data,
                        bytes,
                        data.length - bytes,
                        bytes,
                      );
                      if (!read) break;
                      bytes += read;
                    }
                    if (bytes < data.length)
                      missing.push(`${archiveName}: shortened during export`);
                    data = data.subarray(0, bytes);
                  } finally {
                    closeSync(fd);
                  }
                  const safe = Buffer.from(
                    redactLog(data.toString("utf8"), this.secrets, legacy),
                  );
                  files.push({
                    name: archiveName,
                    bytes: safe.length,
                    modified: snapshot.mtime.toISOString(),
                  });
                  callback(null, Readable.from([safe]));
                } catch {
                  missing.push(
                    `${archiveName}: became unreadable during export`,
                  );
                  callback(
                    null,
                    Readable.from(["[LOG UNAVAILABLE; see manifest.json]\n"]),
                  );
                }
              },
            );
          } catch {
            missing.push(
              `${archiveName}: unreadable, unsafe or exceeds 32 MiB`,
            );
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          missing.push(`${prefix}: unreadable`);
      }
    };
    addDirectory(this.directory, "logs/");
    for (const [index, directory] of additionalDirectories.entries())
      if (directory !== this.directory)
        addDirectory(directory, `startup-logs/${index}/`);
    if (library) {
      const cache = join(library, "cache");
      try {
        if (lstatSync(library).isDirectory() && lstatSync(cache).isDirectory())
          for (const id of readdirSync(cache).sort()) {
            if (/^[0-9a-f]{32}$/.test(id))
              if (!lstatSync(join(cache, id)).isDirectory())
                missing.push(
                  `legacy/translation-failures/${id}/: unsafe directory`,
                );
              else
                addDirectory(
                  join(cache, id, "translation-failures"),
                  `legacy/translation-failures/${id}/`,
                  true,
                );
          }
        else
          missing.push("legacy/translation-failures/: unsafe cache directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          missing.push("legacy/translation-failures/: unreadable");
      }
    }
    if (this.fallback.length) {
      files.push({
        name: "logs/in-memory-fallback.jsonl",
        bytes: Buffer.byteLength(this.fallback.join("")),
        modified: new Date().toISOString(),
      });
      zip.addBuffer(
        Buffer.from(this.fallback.join("")),
        "logs/in-memory-fallback.jsonl",
      );
    }
    addJSON("environment.json", environment);
    addJSON("settings.json", settings);
    zip.addReadStreamLazy("manifest.json", (callback) =>
      callback(
        null,
        Readable.from([
          Buffer.from(
            JSON.stringify(
              redact(
                {
                  formatVersion: 1,
                  exportedAt: new Date().toISOString(),
                  sessionId: this.sessionId,
                  files,
                  missing,
                  droppedWrites: this.droppedWrites,
                  retention,
                  redactions: [
                    "credentials, URLs and user paths",
                    "legacy raw document/model output removed",
                    "settings allowlist; no library database or documents",
                  ],
                },
                this.secrets,
              ),
              null,
              2,
            ),
          ),
        ]),
      ),
    );
    zip.addBuffer(
      Buffer.from(
        "NeoRead 本地诊断包\n包含全部已保留日志，跨会话、不按级别筛选；时间采用 UTC。\n凭据、URL、用户路径和旧翻译日志的模型正文已脱敏。没有包含书库数据库、PDF/EPUB、聊天或批注。\nmanifest.json 列出缺失文件和保留规则。反馈时请附上发生时间、操作步骤、预期结果和实际结果。\n日志无法保证复现依赖特定文档的问题。此文件由用户手动导出，没有自动上传。\n",
      ),
      "README.txt",
    );
    zip.end();
    await result;
    return {
      files: files.length,
      missing: missing.length,
      filename: basename(path),
    };
  }
}

/** Safe scalar settings cached by the main process; no API keys, endpoint or text. */
export function diagnosticSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe: Record<string, unknown> = {};
  const v = value as Record<string, unknown>;
  for (const key of [
    "appearance",
    "autoTranslatePDF",
    "linkTranslationAnnotations",
    "textReflow",
    "translationFontFamily",
    "translationFontSize",
    "mode",
    "primaryMode",
    "provider",
    "chatModel",
    "translationModel",
  ]) {
    if (
      typeof v[key] === "boolean" ||
      typeof v[key] === "number" ||
      (typeof v[key] === "string" && v[key].length < 100)
    )
      safe[key] = v[key];
  }
  return safe;
}
