import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverSpawnDiagnostics } from "./server-spawn-diagnostics";

const directory = mkdtempSync(join(tmpdir(), "reader-spawn-diagnostics-"));
afterEach(() => rmSync(join(directory, "reader-server.exe"), { force: true }));

it("distinguishes a missing packaged server without exposing its path", () => {
  const binary = join(directory, "reader-server.exe");
  expect(
    serverSpawnDiagnostics(binary, { code: "ENOENT", path: binary }),
  ).toEqual({
    systemCode: "ENOENT",
    binaryStatus: "missing",
  });
});

it("reports an existing server and bounds unexpected error codes", () => {
  const binary = join(directory, "reader-server.exe");
  writeFileSync(binary, "fixture");
  expect(serverSpawnDiagnostics(binary, { code: "EPERM" })).toEqual({
    systemCode: "EPERM",
    binaryStatus: "file",
  });
  expect(serverSpawnDiagnostics(binary, { code: binary })).toEqual({
    systemCode: "unknown",
    binaryStatus: "file",
  });
});
