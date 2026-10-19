import { describe, expect, it, vi } from "vitest";
import { writeSync } from "node:fs";
import { safeError, stage } from "./diagnostics";

vi.mock("node:fs", () => ({ writeSync: vi.fn() }));

describe("layout diagnostics privacy", () => {
  it("flushes stage and numeric runtime evidence before native initialization", () => {
    stage("session_create", 0, "1.30.0");
    const [fd, data] = vi.mocked(writeSync).mock.calls.at(-1)!;
    expect(fd).toBe(1);
    const event = JSON.parse(data as string);
    expect(event).toMatchObject({
      event: "diagnostic",
      stage: "session_create",
      onnxVersion: "1.30.0",
      nodeVersion: process.versions.node,
    });
    for (const key of [
      "rssBytes",
      "heapUsedBytes",
      "externalBytes",
      "freeMemoryBytes",
      "totalMemoryBytes",
    ]) {
      expect(event[key]).toBeGreaterThanOrEqual(0);
    }
    expect(event).not.toHaveProperty("env");
    expect(event).not.toHaveProperty("argv");
  });
  it("keeps native loader codes without leaking message, path or stack", () => {
    const error = Object.assign(
      new Error("C:\\Users\\private\\secret.pdf token=private-secret"),
      { code: "ERR_DLOPEN_FAILED" },
    );
    const result = safeError(error);
    expect(result.errorCode).toBe("ERR_DLOPEN_FAILED");
    expect(result.errorFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|Users/);
  });
  it("extracts native loader codes from wrapped causes", () => {
    const cause = Object.assign(new Error("private path"), {
      code: "ERR_DLOPEN_FAILED",
    });
    expect(
      safeError(new Error("native binding failed", { cause })).errorCode,
    ).toBe("ERR_DLOPEN_FAILED");
  });
  it("rejects arbitrary error fields and handles non-errors", () => {
    expect(
      safeError({ name: "PRIVATE", code: "PRIVATE", message: "PRIVATE" }),
    ).toMatchObject({ errorType: "unknown", errorCode: "unknown" });
    expect(safeError(null).errorCode).toBe("unknown");
  });
});
