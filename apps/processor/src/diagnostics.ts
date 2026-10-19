import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { freemem, totalmem } from "node:os";

let currentStage = "bootstrap";
let currentPage = 0;
const started = performance.now();

export function stage(value: string, page = 0, onnxVersion = "") {
  currentStage = value;
  currentPage = page;
  emit({ status: "start", onnxVersion });
}

export function safeError(error: unknown) {
  const value = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  const name = typeof value?.name === "string" ? value.name : "";
  let code = typeof value?.code === "string" ? value.code : "";
  let cause = value?.cause;
  // Native binding wrappers often put the loader code on Error.cause.
  for (let depth = 0; !code && cause && depth < 4; depth++) {
    const nested = cause as { code?: unknown; cause?: unknown };
    if (typeof nested.code === "string") code = nested.code;
    cause = nested.cause;
  }
  const message = typeof value?.message === "string" ? value.message : "";
  return {
    errorType: [
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "PasswordException",
      "InvalidPDFException",
      "MissingPDFException",
      "UnknownErrorException",
    ].includes(name)
      ? name
      : "unknown",
    errorCode: [
      "ENOENT",
      "EACCES",
      "EPERM",
      "ENOSPC",
      "ENOMEM",
      "ERR_DLOPEN_FAILED",
      "MODULE_NOT_FOUND",
      "ERR_MODULE_NOT_FOUND",
    ].includes(code)
      ? code
      : "unknown",
    // Messages can contain document text, paths, or credentials. Keep only a
    // fingerprint to correlate failures, never their raw message or stack.
    errorFingerprint: createHash("sha256")
      .update(name + "\n" + code + "\n" + message)
      .digest("hex")
      .slice(0, 16),
  };
}

export function failure(error: unknown) {
  emit({ status: "failed", ...safeError(error) });
}

function emit(fields: Record<string, string>) {
  const memory = process.memoryUsage();
  // Flush before entering native code: an abrupt process termination must not
  // lose the last stage in Node's asynchronous pipe buffer.
  writeSync(
    1,
    JSON.stringify({
      event: "diagnostic",
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? "",
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      freeMemoryBytes: freemem(),
      totalMemoryBytes: totalmem(),
      stage: currentStage,
      page: currentPage,
      durationMs: Math.round(performance.now() - started),
      ...fields,
    }) + "\n",
  );
}
