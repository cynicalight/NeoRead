import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  citePluginStatus,
  wordAccessFolder,
  authorizeWordPluginAccess,
  installCitePlugin,
  parseWindowsWordFolders,
  registerWPS,
  uninstallCitePlugin,
  unregisterWPS,
  type CitePluginOptions,
} from "./cite-plugins";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: vi.fn(
    (await importOriginal<typeof import("node:fs/promises")>()).access,
  ),
  copyFile: vi.fn(
    (await importOriginal<typeof import("node:fs/promises")>()).copyFile,
  ),
}));

async function setup(platform: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), "neoread-cite-"));
  const plugins = join(root, "plugins");
  await mkdir(join(plugins, "word"), { recursive: true });
  await mkdir(join(plugins, "wps"), { recursive: true });
  await writeFile(join(plugins, "word", "NeoRead.dotm"), "template");
  await writeFile(join(plugins, "word", "NeoReadCite.applescript"), "script");
  await writeFile(join(plugins, "wps", "index.html"), "<html>");
  const options: CitePluginOptions = {
    platform,
    home: join(root, "home"),
    appData: join(root, "appdata"),
    plugins,
    compileAppleScript: vi.fn(async (_source: string, target: string) => {
      await writeFile(target, "compiled");
    }),
  };
  return { root, options };
}

const bootstrapKey = "a".repeat(64);

describe("WPS registration", () => {
  it("adds one entry and keeps other add-ins", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n  <jsplugin name="wps-zotero" type="wps" url="http://127.0.0.1:3889/" version="1"/>\n</jsplugins>';
    const once = registerWPS(xml, "publish", bootstrapKey);
    const twice = registerWPS(once, "publish", bootstrapKey);
    expect(twice).toBe(once);
    expect(once.match(/name="neoread-cite"/g)).toHaveLength(1);
    expect(once).toContain(
      'url="http://127.0.0.1:17841/wps/' + bootstrapKey + '/"',
    );
    expect(once).toContain('name="wps-zotero"');
    expect(unregisterWPS(once)).toBe(xml);
  });

  it("creates a file and rejects unknown formats", () => {
    expect(registerWPS("", "jsplugins", bootstrapKey)).toMatch(
      /<jsplugins>\n {2}<jsplugin name="neoread-cite"/,
    );
    expect(() => registerWPS("<other/>", "jsplugins", bootstrapKey)).toThrow();
  });
});

describe("Windows Word folders", () => {
  it("expands variables, prefers Word settings and deduplicates registry views", () => {
    const registry = String.raw`HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Common\General
    Startup    REG_SZ    LegacyStartup
HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Word\Options
    STARTUP-PATH    REG_EXPAND_SZ    %APPDATA%\Custom Word
HKEY_LOCAL_MACHINE\Software\Microsoft\Office\16.0\Word
HKEY_CURRENT_USER\Software\Microsoft\Office\17.0\Word\Options
    STARTUP-PATH    REG_SZ    C:\Users\me\AppData\Roaming\custom word`;
    expect(
      parseWindowsWordFolders(registry, {
        APPDATA: String.raw`C:\Users\me\AppData\Roaming`,
      }),
    ).toEqual({
      folders: [String.raw`C:\Users\me\AppData\Roaming\custom word`],
      detected: true,
    });
  });

  it("resolves the legacy relative Startup value", () => {
    expect(
      parseWindowsWordFolders(
        String.raw`HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Common\General
    Startup    REG_SZ    Startup`,
        { APPDATA: String.raw`C:\Roaming` },
      ).folders,
    ).toEqual([String.raw`C:\Roaming\Microsoft\Word\Startup`]);
  });
});

it("reports permission errors instead of treating Word as absent", async () => {
  const { options } = await setup("darwin");
  vi.mocked(access).mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  await expect(citePluginStatus(options)).rejects.toMatchObject({
    code: "EACCES",
  });
});

it("only offers authorization for a denied Word folder on macOS", async () => {
  const { options, root } = await setup("darwin");
  const office = join(
    options.home,
    "Library/Group Containers/UBF8T346G9.Office",
  );
  await mkdir(office, { recursive: true });
  const denied = (path: string) =>
    Object.assign(new Error("denied"), { code: "EACCES", path });
  expect(wordAccessFolder(denied(office), options)).toBe(office);
  expect(wordAccessFolder(denied(join(office, "NeoRead.dotm")), options)).toBe(
    office,
  );
  expect(wordAccessFolder(denied(join(root, "elsewhere")), options)).toBeNull();
  expect(
    wordAccessFolder(denied(office), { ...options, platform: "win32" }),
  ).toBeNull();
  options.requestFolderAccess = vi.fn(async (folder) => folder);
  await authorizeWordPluginAccess(office, options);
  expect(options.requestFolderAccess).toHaveBeenCalledWith(office);
  options.requestFolderAccess = vi.fn(async () => null);
  await expect(authorizeWordPluginAccess(office, options)).rejects.toThrow(
    "已取消",
  );
});

describe("installing", () => {
  it.each(["darwin", "win32"] as const)(
    "overwrites an installed Word plugin on %s without uninstalling",
    async (platform) => {
      const { options } = await setup(platform);
      await mkdir(
        platform === "darwin"
          ? join(options.home, "Library/Group Containers/UBF8T346G9.Office")
          : join(options.appData, "Microsoft/Word"),
        { recursive: true },
      );
      await installCitePlugin("word", options);
      await writeFile(
        join(options.plugins, "word/NeoRead.dotm"),
        "updated template",
      );
      options.compileAppleScript = vi.fn(async (_source, target) => {
        await writeFile(target, "updated script");
      });
      await installCitePlugin("word", options);
      const target =
        platform === "darwin"
          ? join(
              options.home,
              "Library/Group Containers/UBF8T346G9.Office/User Content.localized/Startup.localized/Word/NeoRead.dotm",
            )
          : join(options.appData, "Microsoft/Word/STARTUP/NeoRead.dotm");
      expect(await readFile(target, "utf8")).toBe("updated template");
      if (platform === "darwin")
        expect(
          await readFile(
            join(
              options.home,
              "Library/Application Scripts/com.microsoft.Word/NeoReadCite.scpt",
            ),
            "utf8",
          ),
        ).toBe("updated script");
      expect((await citePluginStatus(options))[0].installed).toBe(true);
    },
  );
  it("replaces the legacy Word template only after installing NeoRead", async () => {
    const { options } = await setup("win32");
    const folder = join(options.appData, "Microsoft/Word/STARTUP");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "Reader.dotm"), "legacy");
    await installCitePlugin("word", options);
    expect(await readFile(join(folder, "NeoRead.dotm"), "utf8")).toBe(
      "template",
    );
    await expect(readFile(join(folder, "Reader.dotm"))).rejects.toThrow();
  });

  it("replaces the old WPS registration and preserves its installation key", async () => {
    const { options } = await setup("win32");
    const legacy = join(options.appData, "Reader");
    const folder = join(options.appData, "kingsoft/wps/jsaddons");
    await mkdir(legacy, { recursive: true });
    await mkdir(folder, { recursive: true });
    await writeFile(join(legacy, "cite-wps-key"), bootstrapKey);
    await writeFile(
      join(folder, "publish.xml"),
      '<jsplugins><jsplugin name="reader-cite"/></jsplugins>',
    );
    await installCitePlugin("wps", options);
    expect(
      await readFile(join(options.appData, "NeoRead/cite-wps-key"), "utf8"),
    ).toBe(bootstrapKey);
    const xml = await readFile(join(folder, "publish.xml"), "utf8");
    expect(xml).toContain('name="neoread-cite"');
    expect(xml).not.toContain('name="reader-cite"');
  });

  it("uses configured Windows folders for installation, status and removal", async () => {
    const { options, root } = await setup("win32");
    const folder = join(root, "custom-startup");
    options.windowsWordFolders = async () => ({
      detected: true,
      folders: [folder],
    });
    await installCitePlugin("word", options);
    expect(await readFile(join(folder, "NeoRead.dotm"), "utf8")).toBe(
      "template",
    );
    expect((await citePluginStatus(options))[0].installed).toBe(true);
    await uninstallCitePlugin("word", options);
    expect((await citePluginStatus(options))[0].installed).toBe(false);
  });
  it("installs the Word template and script on macOS", async () => {
    const { options } = await setup("darwin");
    await expect(installCitePlugin("word", options)).rejects.toThrow(
      "未检测到 Microsoft Word",
    );
    await mkdir(
      join(options.home, "Library/Group Containers/UBF8T346G9.Office"),
      {
        recursive: true,
      },
    );
    await installCitePlugin("word", options);
    const template = join(
      options.home,
      "Library/Group Containers/UBF8T346G9.Office/User Content.localized/Startup.localized/Word/NeoRead.dotm",
    );
    expect(await readFile(template, "utf8")).toBe("template");
    expect(options.compileAppleScript).toHaveBeenCalledWith(
      join(options.plugins, "word", "NeoReadCite.applescript"),
      expect.stringMatching(/neoread-word-.*[/\\]NeoReadCite\.scpt$/),
    );
    const [word, wps] = await citePluginStatus(options);
    expect(word).toEqual({
      kind: "word",
      supported: true,
      detected: true,
      available: true,
      installed: true,
    });
    expect(wps.supported).toBe(false);
    await uninstallCitePlugin("word", options);
    expect((await citePluginStatus(options))[0].installed).toBe(false);
  });

  it("requests macOS folder access only after a denied write and retries", async () => {
    const { options } = await setup("darwin");
    await mkdir(
      join(options.home, "Library/Group Containers/UBF8T346G9.Office"),
      { recursive: true },
    );
    options.requestFolderAccess = vi.fn(async (folder) => folder);
    vi.mocked(copyFile).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EPERM" }),
    );
    await installCitePlugin("word", options);
    expect(options.requestFolderAccess).toHaveBeenCalledWith(
      join(options.home, "Library/Application Scripts/com.microsoft.Word"),
    );
    expect((await citePluginStatus(options))[0].installed).toBe(true);
    expect(
      await readFile(
        join(
          options.home,
          "Library/Application Scripts/com.microsoft.Word/NeoReadCite.scpt",
        ),
        "utf8",
      ),
    ).toBe("compiled");
  });

  it("authorizes the actual localized Word startup folder", async () => {
    const { options } = await setup("darwin");
    await mkdir(
      join(options.home, "Library/Group Containers/UBF8T346G9.Office"),
      { recursive: true },
    );
    options.requestFolderAccess = vi.fn(async (folder) => folder);
    const real =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(copyFile)
      .mockImplementationOnce(real.copyFile)
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EPERM" }),
      );
    await installCitePlugin("word", options);
    expect(options.requestFolderAccess).toHaveBeenCalledWith(
      join(
        options.home,
        "Library/Group Containers/UBF8T346G9.Office/User Content.localized/Startup.localized/Word",
      ),
    );
  });

  it.each([null, "wrong-folder"])(
    "does not continue after cancelled or incorrect folder authorization: %s",
    async (selected) => {
      const { options, root } = await setup("darwin");
      await mkdir(
        join(options.home, "Library/Group Containers/UBF8T346G9.Office"),
        { recursive: true },
      );
      const wrong = join(root, "wrong-folder");
      await mkdir(wrong);
      options.requestFolderAccess = vi.fn(async () =>
        selected === null ? null : wrong,
      );
      vi.mocked(copyFile).mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
      await expect(installCitePlugin("word", options)).rejects.toThrow(
        selected === null ? "已取消" : "请选择指定",
      );
      expect((await citePluginStatus(options))[0].installed).toBe(false);
    },
  );

  it("does not report denied Windows access as a running Word instance", async () => {
    const { options } = await setup("win32");
    await mkdir(join(options.appData, "Microsoft/Word"), { recursive: true });
    vi.mocked(copyFile).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EPERM" }),
    );
    await expect(installCitePlugin("word", options)).rejects.toThrow(
      "检查目录权限",
    );
  });

  it("registers the WPS add-in on Windows", async () => {
    const { options } = await setup("win32");
    await installCitePlugin("wps", options);
    const folder = join(options.appData, "kingsoft", "wps", "jsaddons");
    expect(await readFile(join(folder, "publish.xml"), "utf8")).toContain(
      'name="neoread-cite"',
    );
    expect((await citePluginStatus(options))[1].installed).toBe(true);
    const keyPath = join(options.appData, "NeoRead", "cite-wps-key");
    const key = await readFile(keyPath, "utf8");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    const registered = await readFile(join(folder, "publish.xml"), "utf8");
    expect(registered).toContain("/wps/" + key + "/");

    if (process.platform !== "win32") {
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(folder, "publish.xml"))).mode & 0o777).toBe(
        0o600,
      );
    }
    await installCitePlugin("wps", options);
    expect(await readFile(keyPath, "utf8")).toBe(key);
    await uninstallCitePlugin("wps", options);
    await expect(readFile(keyPath)).rejects.toThrow();
    expect((await citePluginStatus(options))[1].installed).toBe(false);
  });

  it("reports a build without the Word template", async () => {
    const { options } = await setup("win32");
    await mkdir(join(options.appData, "Microsoft", "Word"), {
      recursive: true,
    });
    await writeFile(join(options.plugins, "word", "NeoRead.dotm"), "");
    const { rm } = await import("node:fs/promises");
    await rm(join(options.plugins, "word", "NeoRead.dotm"));
    expect((await citePluginStatus(options))[0].available).toBe(false);
    await expect(installCitePlugin("word", options)).rejects.toThrow(
      "没有附带 Word 模板",
    );
  });
});
