import type { Canvas } from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { TextSpan } from "./layout";

function ocrError(code: string) {
  return Object.assign(new Error(code), { code });
}

function launchHelper() {
  // The lazy worker chunk and the smoke-test entrypoint are built alongside
  // the native binary, independent of the worker's cwd.
  const binary = fileURLToPath(new URL("./apple-ocr-helper", import.meta.url));
  try {
    return spawn(binary, [String(process.pid)], {
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    throw ocrError("APPLE_OCR_SPAWN");
  }
}

export async function createAppleOCR(): Promise<{
  recognize(canvas: Canvas): Promise<TextSpan[]>;
  close(): Promise<void>;
}> {
  if (process.platform !== "darwin") throw ocrError("APPLE_OCR_PLATFORM");
  const child = launchHelper();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  let transportError = "APPLE_OCR_EXIT";
  child.on("error", () => {
    transportError = "APPLE_OCR_SPAWN";
    lines.close();
  });
  child.stdin.on("error", () => {
    // Native crashes and cancellation can break a pending pixel write.
    transportError = "APPLE_OCR_WRITE";
    // Closing the reader settles the awaiting request without logging EPIPE.
    lines.close();
  });
  // Unlike events.once(), this waits for close even after a spawn error.
  const exited = new Promise<void>((resolve) => child.once("close", resolve));
  let closed = false;
  async function close() {
    if (!closed) {
      closed = true;
      lines.close();
      child.stdin.destroy();
      child.kill();
    }
    await exited;
  }
  async function receive(): Promise<{ ready?: boolean; spans?: TextSpan[] }> {
    const next = await replies.next().catch(() => {
      throw ocrError("APPLE_OCR_READ");
    });
    if (closed) throw ocrError("APPLE_OCR_CLOSED");
    if (next.done) throw ocrError(transportError);
    let response;
    try {
      response = JSON.parse(next.value);
    } catch {
      throw ocrError("APPLE_OCR_PROTOCOL");
    }
    if (!response || typeof response !== "object")
      throw ocrError("APPLE_OCR_PROTOCOL");
    switch (response.error) {
      case "APPLE_OCR_LANGUAGES":
      case "APPLE_OCR_RECOGNITION":
      case "APPLE_OCR_FRAME":
        throw ocrError(response.error);
    }
    return response;
  }
  try {
    if ((await receive()).ready !== true) throw ocrError("APPLE_OCR_PROTOCOL");
  } catch (error) {
    await close();
    throw error;
  }

  let busy = false;
  return {
    async recognize(canvas) {
      if (closed) throw ocrError("APPLE_OCR_CLOSED");
      if (busy) throw ocrError("APPLE_OCR_BUSY");
      if (child.exitCode !== null || child.signalCode !== null)
        throw ocrError("APPLE_OCR_EXIT");
      busy = true;
      try {
        const { width, height } = canvas;
        if (
          width < 1 ||
          height < 1 ||
          width > 16_384 ||
          height > 16_384 ||
          width * height > 4_250_000
        )
          throw ocrError("APPLE_OCR_FRAME");
        let rgba: Uint8ClampedArray;
        try {
          rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
        } catch {
          throw ocrError("APPLE_OCR_FRAME");
        }
        const header = Buffer.allocUnsafe(8);
        header.writeUInt32LE(width, 0);
        header.writeUInt32LE(height, 4);
        child.stdin.cork();
        child.stdin.write(header);
        child.stdin.write(
          Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        );
        child.stdin.uncork();
        const { spans } = await receive();
        if (!Array.isArray(spans)) throw ocrError("APPLE_OCR_PROTOCOL");
        return spans;
      } finally {
        busy = false;
      }
    },
    close,
  };
}
