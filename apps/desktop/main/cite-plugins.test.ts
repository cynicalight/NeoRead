import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  citePluginStatus,
  installCitePlugin,
  registerWPS,
  uninstallCitePlugin,
  unregisterWPS,
  type CitePluginOptions,
} from "./cite-plugins";

async function setup(platform: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), "reader-cite-"));
  const plugins = join(root, "plugins");
  await mkdir(join(plugins, "word"), { recursive: true });
  await mkdir(join(plugins, "wps"), { recursive: true });
  await writeFile(join(plugins, "word", "Reader.dotm"), "template");
  await writeFile(join(plugins, "word", "ReaderCite.applescript"), "script");
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
    expect(once.match(/name="reader-cite"/g)).toHaveLength(1);
    expect(once).toContain(
      'url="http://127.0.0.1:17841/wps/' + bootstrapKey + '/"',
    );
    expect(once).toContain('name="wps-zotero"');
    expect(unregisterWPS(once)).toBe(xml);
  });

  it("creates a file and rejects unknown formats", () => {
    expect(registerWPS("", "jsplugins", bootstrapKey)).toMatch(
      /<jsplugins>\n {2}<jsplugin name="reader-cite"/,
    );
    expect(() => registerWPS("<other/>", "jsplugins", bootstrapKey)).toThrow();
  });
});

describe("installing", () => {
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
      "Library/Group Containers/UBF8T346G9.Office/User Content/Startup/Word/Reader.dotm",
    );
    expect(await readFile(template, "utf8")).toBe("template");
    expect(options.compileAppleScript).toHaveBeenCalledWith(
      join(options.plugins, "word", "ReaderCite.applescript"),
      join(
        options.home,
        "Library/Application Scripts/com.microsoft.Word/ReaderCite.scpt",
      ),
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

  it("registers the WPS add-in on Windows", async () => {
    const { options } = await setup("win32");
    await installCitePlugin("wps", options);
    const folder = join(options.appData, "kingsoft", "wps", "jsaddons");
    expect(await readFile(join(folder, "publish.xml"), "utf8")).toContain(
      'name="reader-cite"',
    );
    expect((await citePluginStatus(options))[1].installed).toBe(true);
    const keyPath = join(options.appData, "Reader", "cite-wps-key");
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
    await writeFile(join(options.plugins, "word", "Reader.dotm"), "");
    const { rm } = await import("node:fs/promises");
    await rm(join(options.plugins, "word", "Reader.dotm"));
    expect((await citePluginStatus(options))[0].available).toBe(false);
    await expect(installCitePlugin("word", options)).rejects.toThrow(
      "没有附带 Word 模板",
    );
  });
});
