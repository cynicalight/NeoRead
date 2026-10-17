import { createHash } from "node:crypto";

let currentStage = "bootstrap";
let currentPage = 0;
const started = performance.now();

export function stage(value: string, page = 0) {
  currentStage = value;
  currentPage = page;
  emit({ status: "start" });
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
  process.stdout.write(
    JSON.stringify({
      event: "diagnostic",
      stage: currentStage,
      page: currentPage,
      durationMs: Math.round(performance.now() - started),
      ...fields,
    }) + "\n",
  );
}
