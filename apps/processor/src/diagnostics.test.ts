import { describe, expect, it } from "vitest";
import { safeError } from "./diagnostics";

describe("layout diagnostics privacy", () => {
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
