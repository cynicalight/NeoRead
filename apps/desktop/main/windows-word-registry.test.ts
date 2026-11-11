import { beforeEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: run,
  }),
}));

import { windowsWordFolders } from "./cite-plugins";

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ stdout: "", stderr: "" });
  vi.unstubAllEnvs();
});

describe("Windows Word registry queries", () => {
  it("reads startup values through the registry API without dumping Office", async () => {
    await windowsWordFolders();
    expect(run).toHaveBeenCalledTimes(1);
    const [executable, args, options] = run.mock.calls[0];
    expect(executable).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      expect.any(String),
    ]);
    const script = Buffer.from(args[4], "base64").toString("utf16le");
    expect(script).toContain("[Microsoft.Win32.RegistryKey]::OpenBaseKey");
    expect(script).toContain("RegistryView]::Registry64");
    expect(script).toContain("RegistryView]::Registry32");
    expect(script).toContain("RegistryHive]::CurrentUser");
    expect(script).toContain("RegistryHive]::LocalMachine");
    expect(script).toContain("$office.GetSubKeyNames()");
    expect(script).toContain(
      "Write-StartupValue $word 'Options' 'STARTUP-PATH'",
    );
    expect(script).toContain(
      "Write-StartupValue $office ($version + '\\Common\\General') 'Startup'",
    );
    expect(script).toContain("DoNotExpandEnvironmentNames");
    expect(script).not.toMatch(/reg\.exe|GetValueNames|Recurse/);
    expect(options).toEqual({
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 256 * 1024,
    });
  });

  it("parses Unicode paths, expands variables and prefers the Word setting", async () => {
    vi.stubEnv("APPDATA", String.raw`C:\Users\reader\AppData\Roaming`);
    run.mockResolvedValue({
      stdout:
        "\uFEFF" +
        String.raw`HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Word
HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Word\Options
    STARTUP-PATH    REG_EXPAND_SZ    %APPDATA%\引用插件
HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Common\General
    Startup    REG_EXPAND_SZ    Startup`,
    });
    await expect(windowsWordFolders()).resolves.toEqual({
      detected: true,
      folders: [String.raw`C:\Users\reader\AppData\Roaming\引用插件`],
    });
  });

  it("detects Word with no custom startup value so the caller can use its default", async () => {
    run.mockResolvedValue({
      stdout: String.raw`HKEY_LOCAL_MACHINE\Software\Microsoft\Office\16.0\Word`,
    });
    await expect(windowsWordFolders()).resolves.toEqual({
      detected: true,
      folders: [],
    });
  });

  it("returns no Word installation when registry keys are absent", async () => {
    await expect(windowsWordFolders()).resolves.toEqual({
      detected: false,
      folders: [],
    });
  });

  it.each([1, "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])(
    "preserves registry process failures with code %s",
    async (code) => {
      const error = Object.assign(new Error("registry failed"), { code });
      run.mockRejectedValue(error);
      await expect(windowsWordFolders()).rejects.toBe(error);
    },
  );
});
