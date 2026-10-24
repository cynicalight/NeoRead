import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Installs the Word template and the WPS add-in for the citation plugin.
 * Word loads every template in its startup folder; WPS loads the add-in from
 * Reader's connector port, registered in its jsaddons XML files.
 */
export type CitePluginKind = "word" | "wps";
export type CitePluginStatus = {
  kind: CitePluginKind;
  /** False on platforms Reader cannot install this plugin on yet. */
  supported: boolean;
  /** The word processor appears to be installed. */
  detected: boolean;
  /** The plugin files ship with this Reader build. */
  available: boolean;
  installed: boolean;
};

export type CitePluginOptions = {
  platform: NodeJS.Platform;
  home: string;
  /** Roaming application data on Windows. */
  appData: string;
  /** Directory with `word/` and `wps/` from apps/cite-plugins. */
  plugins: string;
  compileAppleScript?: (source: string, target: string) => Promise<void>;
};

const WPS_NAME = "reader-cite";
const WPS_URL = "http://127.0.0.1:17841/wps/";
const WPS_VERSION = "1.0.0";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

function wordPaths({ platform, home, appData }: CitePluginOptions) {
  if (platform === "darwin") {
    const office = join(home, "Library/Group Containers/UBF8T346G9.Office");
    return {
      office,
      template: join(office, "User Content/Startup/Word/Reader.dotm"),
      script: join(
        home,
        "Library/Application Scripts/com.microsoft.Word/ReaderCite.scpt",
      ),
    };
  }
  if (platform === "win32") {
    const office = join(appData, "Microsoft", "Word");
    return {
      office,
      template: join(office, "STARTUP", "Reader.dotm"),
      script: "",
    };
  }
  return null;
}

/** WPS for macOS is not supported until its add-in folder is verified. */
function wpsFolder({ platform, home, appData }: CitePluginOptions) {
  if (platform === "win32") return join(appData, "kingsoft", "wps", "jsaddons");
  if (platform === "linux")
    return join(home, ".local/share/Kingsoft/wps/jsaddons");
  return null;
}

const wpsEntry = /\s*<jsplugin\b[^>]*\bname="reader-cite"[^>]*\/>/g;

/** Adds Reader's add-in to a WPS jsaddons XML file, replacing an older entry. */
export function registerWPS(
  xml: string,
  file: "jsplugins" | "publish",
  key: string,
) {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid WPS installation key");
  const url = WPS_URL + key + "/";
  const entry =
    file === "publish"
      ? `<jsplugin url="${url}" type="wps" enable="enable_dev" install="null" version="${WPS_VERSION}" name="${WPS_NAME}"/>`
      : `<jsplugin name="${WPS_NAME}" type="wps" url="${url}" version="${WPS_VERSION}"/>`;
  const base = unregisterWPS(
    xml.trim() ||
      '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>',
  );
  if (!/<jsplugins\b[^>]*>/.test(base))
    throw new Error("WPS 加载项配置文件格式无法识别");
  return base.replace(/<jsplugins\b[^>]*>/, (open) => `${open}\n  ${entry}`);
}

export function unregisterWPS(xml: string) {
  return xml.replace(wpsEntry, "");
}

export async function citePluginStatus(
  options: CitePluginOptions,
): Promise<CitePluginStatus[]> {
  const word = wordPaths(options);
  const wps = wpsFolder(options);
  const registered = async (folder: string) =>
    (
      await readFile(join(folder, "publish.xml"), "utf8").catch(() => "")
    ).includes(`name="${WPS_NAME}"`);
  return [
    {
      kind: "word",
      supported: !!word,
      detected: !!word && (await exists(word.office)),
      available: await exists(join(options.plugins, "word", "Reader.dotm")),
      installed: !!word && (await exists(word.template)),
    },
    {
      kind: "wps",
      supported: !!wps,
      detected: !!wps && (await exists(dirname(wps))),
      available: await exists(join(options.plugins, "wps", "index.html")),
      installed: !!wps && (await registered(wps)),
    },
  ];
}

const run = promisify(execFile);
const osacompile = async (source: string, target: string) => {
  await run("osacompile", ["-o", target, source]);
};

export async function installCitePlugin(
  kind: CitePluginKind,
  options: CitePluginOptions,
) {
  if (kind === "word") {
    const word = wordPaths(options);
    if (!word) throw new Error("当前系统不支持 Word 插件");
    if (!(await exists(word.office)))
      throw new Error("未检测到 Microsoft Word，请先安装并打开一次 Word");
    const template = join(options.plugins, "word", "Reader.dotm");
    if (!(await exists(template)))
      throw new Error("这个 Reader 版本没有附带 Word 模板");
    await mkdir(dirname(word.template), { recursive: true });
    try {
      await copyFile(template, word.template);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM")
        throw new Error("Word 正在使用插件，请先退出 Word 再安装");
      throw e;
    }
    if (word.script) {
      await mkdir(dirname(word.script), { recursive: true });
      await (options.compileAppleScript || osacompile)(
        join(options.plugins, "word", "ReaderCite.applescript"),
        word.script,
      );
    }
    return;
  }
  const folder = wpsFolder(options);
  if (!folder) throw new Error("当前系统暂不支持 WPS 插件");
  const keyPath = join(options.appData, "Reader", "cite-wps-key");
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  // WPS appends ribbon.xml/index.html; protect the installation base path.
  let key = await readFile(keyPath, "utf8").catch(() => "");
  if (!/^[a-f0-9]{64}$/.test(key)) {
    key = randomBytes(32).toString("hex");
    await writeFile(keyPath, key, { mode: 0o600 });
  }
  await chmod(keyPath, 0o600);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const file of ["jsplugins", "publish"] as const) {
    const path = join(folder, `${file}.xml`);
    const xml = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, registerWPS(xml, file, key), { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

export async function uninstallCitePlugin(
  kind: CitePluginKind,
  options: CitePluginOptions,
) {
  if (kind === "word") {
    const word = wordPaths(options);
    if (!word) return;
    try {
      await rm(word.template, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EBUSY")
        throw new Error("Word 正在使用插件，请先退出 Word 再卸载");
      throw e;
    }
    if (word.script) await rm(word.script, { force: true });
    return;
  }
  const folder = wpsFolder(options);
  if (!folder) return;
  for (const file of ["jsplugins", "publish"]) {
    const path = join(folder, `${file}.xml`);
    const xml = await readFile(path, "utf8").catch(() => null);
    if (xml !== null) await writeFile(path, unregisterWPS(xml));
  }
  await rm(join(options.appData, "Reader", "cite-wps-key"), { force: true });
}
