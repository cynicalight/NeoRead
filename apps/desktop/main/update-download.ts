import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { installerChecksum, type ReleaseUpdate } from "./updates";

type Request = (url: string, init: RequestInit) => Promise<Response>;
/** Total is undefined when the server omits Content-Length. */
export type DownloadProgress = (received: number, total?: number) => void;
async function readBody(
  response: Response,
  max: number,
  consume: (chunk: Uint8Array) => Promise<void>,
) {
  if (!response.ok || !response.body)
    throw new Error(`更新下载失败 (${response.status})`);
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error("更新文件超过大小限制");
      await consume(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return size;
}
export async function downloadUpdate(
  update: ReleaseUpdate,
  directory: string,
  request: Request,
  onProgress?: DownloadProgress,
): Promise<string> {
  // Only selectRelease can supply these URLs; they are never renderer-controlled.
  const options: RequestInit = {
    signal: AbortSignal.timeout(30 * 60 * 1000),
    credentials: "omit",
  };
  const chunks: Buffer[] = [];
  await readBody(
    await request(update.checksumURL, options),
    64 * 1024,
    async (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
  );
  const expected = installerChecksum(
    Buffer.concat(chunks).toString("utf8"),
    update.installer,
  );
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, "reader-update-"));
  const path = join(temporary, update.installer);
  const partial = `${path}.part`;
  try {
    const file = await open(partial, "wx", 0o600);
    const digest = createHash("sha256");
    let size: number;
    try {
      const response = await request(update.downloadURL, options);
      const total = Number(response.headers.get("content-length")) || undefined;
      let received = 0;
      onProgress?.(0, total);
      size = await readBody(response, 1024 * 1024 * 1024, async (chunk) => {
        digest.update(chunk);
        await file.writeFile(chunk);
        received += chunk.byteLength;
        onProgress?.(received, total);
      });
      await file.sync();
    } finally {
      await file.close();
    }
    if (size < 1024 * 1024 || digest.digest("hex") !== expected)
      throw new Error("安装包完整性校验失败，请稍后重试");
    await rename(partial, path);
    return path;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
