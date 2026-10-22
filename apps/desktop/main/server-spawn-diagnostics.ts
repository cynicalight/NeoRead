import { lstatSync } from "node:fs";

const systemCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EINVAL",
  "ENOEXEC",
  "EIO",
]);

/** Describe a failed sidecar launch without recording the user's install path. */
export function serverSpawnDiagnostics(binary: string, error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  let binaryStatus: "file" | "missing" | "not_file" | "unreadable";
  try {
    binaryStatus = lstatSync(binary).isFile() ? "file" : "not_file";
  } catch (failure) {
    binaryStatus =
      (failure as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing"
        : "unreadable";
  }
  return {
    systemCode:
      typeof code === "string" && systemCodes.has(code) ? code : "unknown",
    binaryStatus,
  };
}
