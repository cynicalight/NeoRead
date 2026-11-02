import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import { promisify } from "node:util";

/**
 * Installs the Word template and the WPS add-in for the citation plugin.
 * Word loads every template in its startup folder; WPS loads the add-in from
 * NeoRead's connector port, registered in its jsaddons XML files.
 */
export type CitePluginKind = "word" | "wps";
export type CitePluginStatus = {
  kind: CitePluginKind;
  /** False on platforms NeoRead cannot install this plugin on yet. */
  supported: boolean;
  /** The word processor appears to be installed. */
  detected: boolean;
  /** The plugin files ship with this NeoRead build. */
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
  requestFolderAccess?: (folder: string) => Promise<string | null>;
  windowsWordFolders?: () => Promise<{ folders: string[]; detected: boolean }>;
};

const WPS_NAME = "neoread-cite";
const WPS_URL = "http://127.0.0.1:17841/wps/";
const WPS_VERSION = "1.0.0";

const exists = (path: string) =>
  access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );

function wordPaths({ platform, home, appData }: CitePluginOptions) {
  if (platform === "darwin") {
    const office = join(home, "Library/Group Containers/UBF8T346G9.Office");
    return {
      office,
      template: join(
        office,
        "User Content.localized/Startup.localized/Word/NeoRead.dotm",
      ),
      script: join(
        home,
        "Library/Application Scripts/com.microsoft.Word/NeoReadCite.scpt",
      ),
    };
  }
  if (platform === "win32") {
    const office = join(appData, "Microsoft", "Word");
    return {
      office,
      template: join(office, "STARTUP", "NeoRead.dotm"),
      script: "",
    };
  }
  return null;
}

export async function windowsWordFolders() {
  const query = async (key: string, view: string) => {
    try {
      return (
        await run("reg.exe", ["query", key, "/s", view], {
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      // reg.exe exits with 1 for an absent key; other failures must not
      // silently send the plugin to a directory Word will never load.
      if ((error as { code?: unknown }).code === 1) return "";
      throw error;
    }
  };
  const outputs = await Promise.all(
    ["/reg:64", "/reg:32"].flatMap((view) =>
      ["HKCU", "HKLM"].map((hive) =>
        query(`${hive}\\Software\\Microsoft\\Office`, view),
      ),
    ),
  );
  return parseWindowsWordFolders(outputs.join("\n"), process.env);
}

export function parseWindowsWordFolders(text: string, env: NodeJS.ProcessEnv) {
  const folders = new Map<string, string>();
  const candidates = new Map<string, { path?: string; fallback?: string }>();
  let key = "";
  let detected = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      key = line.trim();
      if (/\\\d+\.0\\Word(?:\\|$)/i.test(key)) detected = true;
      continue;
    }
    const value = line.match(
      /^\s*(STARTUP-PATH|Startup)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i,
    );
    if (!value) continue;
    const startup = value[1].toUpperCase() === "STARTUP-PATH";
    if (!(startup ? /\\Word\\Options$/i : /\\Common\\General$/i).test(key))
      continue;
    let folder = value[2].replace(
      /%([^%]+)%/g,
      (match, name: string) =>
        Object.entries(env).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        )?.[1] || match,
    );
    if (!startup && !win32.isAbsolute(folder) && env.APPDATA)
      folder = win32.join(env.APPDATA, "Microsoft", "Word", folder);
    if (!win32.isAbsolute(folder) || /%[^%]+%/.test(folder))
      throw new Error(
        "Word 启动目录配置无效，请在 Word 的文件位置设置中检查启动目录",
      );
    folder = win32.normalize(folder);
    const version = key
      .replace(/\\(?:Word\\Options|Common\\General)$/i, "")
      .toLowerCase();
    const candidate = candidates.get(version) || {};
    if (startup) candidate.path = folder;
    else candidate.fallback = folder;
    candidates.set(version, candidate);
  }
  for (const candidate of candidates.values()) {
    const folder = candidate.path || candidate.fallback;
    if (folder) folders.set(folder.toLowerCase(), folder);
  }
  return { folders: [...folders.values()], detected };
}

async function wordLocations(options: CitePluginOptions) {
  const word = wordPaths(options);
  if (!word) return null;
  if (options.platform !== "win32")
    return {
      ...word,
      templates: [word.template],
      detected: await exists(word.office),
    };
  const configured = options.windowsWordFolders
    ? await options.windowsWordFolders()
    : process.platform === "win32"
      ? await windowsWordFolders()
      : { folders: [], detected: false };
  const store = join(
    options.home,
    "AppData/Local/Packages/Microsoft.Office.Desktop_8wekyb3d8bbwe/LocalCache/Roaming/Microsoft/Word/Startup",
  );
  const folders = configured.folders.length
    ? configured.folders
    : [dirname(word.template)];
  if (await exists(store)) folders.push(store);
  return {
    ...word,
    templates: [
      ...new Map(
        folders.map((folder) => [
          folder.toLowerCase(),
          join(folder, "NeoRead.dotm"),
        ]),
      ).values(),
    ],
    detected:
      configured.detected ||
      (await exists(word.office)) ||
      (await exists(store)),
  };
}

/** WPS for macOS is not supported until its add-in folder is verified. */
function wpsFolder({ platform, home, appData }: CitePluginOptions) {
  if (platform === "win32") return join(appData, "kingsoft", "wps", "jsaddons");
  if (platform === "linux")
    return join(home, ".local/share/Kingsoft/wps/jsaddons");
  return null;
}

const wpsEntry =
  /\s*<jsplugin\b[^>]*\bname="(?:neoread-cite|reader-cite)"[^>]*\/>/g;

/** Adds NeoRead's add-in to a WPS jsaddons XML file, replacing an older entry. */
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
  const word = await wordLocations(options);
  const wps = wpsFolder(options);
  const registered = async (folder: string) =>
    (
      await readFile(join(folder, "publish.xml"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return "";
          throw error;
        },
      )
    ).includes(`name="${WPS_NAME}"`);
  return [
    {
      kind: "word",
      supported: !!word,
      detected: !!word && word.detected,
      available: await exists(join(options.plugins, "word", "NeoRead.dotm")),
      installed:
        !!word &&
        (await Promise.all(word.templates.map(exists))).every(Boolean),
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

function permissionDenied(error: unknown) {
  return ["EPERM", "EACCES"].includes(
    (error as NodeJS.ErrnoException).code || "",
  );
}

export function wordAccessFolder(error: unknown, options: CitePluginOptions) {
  if (options.platform !== "darwin" || !permissionDenied(error)) return null;
  const word = wordPaths(options);
  const path = (error as NodeJS.ErrnoException & { path?: string }).path;
  if (!word || !path) return null;
  const rel = relative(word.office, path);
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  return path === word.office ? path : dirname(path);
}

export async function authorizeWordPluginAccess(
  folder: string,
  options: CitePluginOptions,
) {
  if (options.platform !== "darwin" || !options.requestFolderAccess)
    throw new Error("当前系统不支持文件夹授权");
  const selected = await options.requestFolderAccess(folder);
  if (!selected) throw new Error("已取消 Word 插件文件夹授权");
  if ((await realpath(selected)) !== (await realpath(folder)))
    throw new Error("请选择指定的 Word 插件文件夹后重试");
}

async function wordFileOperation(
  target: string,
  options: CitePluginOptions,
  operation: () => Promise<unknown>,
) {
  try {
    await operation();
    return;
  } catch (error) {
    if (!permissionDenied(error)) {
      if ((error as NodeJS.ErrnoException).code === "EBUSY")
        throw new Error("Word 正在使用插件，请先退出 Word 再重试", {
          cause: error,
        });
      throw error;
    }
    if (options.platform !== "darwin" || !options.requestFolderAccess)
      throw new Error(
        "无法写入 Word 插件目录，请检查目录权限，并退出 Word 后重试",
        { cause: error },
      );
  }
  // Grant access to the nearest existing folder when Word has not created
  // its startup or application-scripts directory yet.
  let folder = dirname(target);
  while (dirname(folder) !== folder) {
    try {
      await access(folder);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
      folder = dirname(folder);
    }
  }
  const selected = await options.requestFolderAccess(folder);
  if (!selected) throw new Error("已取消 Word 插件文件夹授权");
  if ((await realpath(selected)) !== (await realpath(folder)))
    throw new Error("请选择指定的 Word 插件文件夹后重试");
  try {
    await operation();
  } catch (error) {
    if (permissionDenied(error))
      throw new Error(
        "仍无法写入 Word 插件目录，请确认已允许文件夹访问并检查目录权限",
        { cause: error },
      );
    throw error;
  }
}

export async function installCitePlugin(
  kind: CitePluginKind,
  options: CitePluginOptions,
) {
  if (kind === "word") {
    const word = await wordLocations(options);
    if (!word) throw new Error("当前系统不支持 Word 插件");
    if (!word.detected)
      throw new Error("未检测到 Microsoft Word，请先安装并打开一次 Word");
    const template = join(options.plugins, "word", "NeoRead.dotm");
    if (!(await exists(template)))
      throw new Error("这个 NeoRead 版本没有附带 Word 模板");
    // Compile outside Word's protected directory so permission failures come
    // from filesystem operations, rather than an opaque osacompile exit code.
    const temporary = word.script
      ? await mkdtemp(join(tmpdir(), "neoread-word-"))
      : undefined;
    try {
      const script = temporary && join(temporary, "NeoReadCite.scpt");
      if (script)
        await (options.compileAppleScript || osacompile)(
          join(options.plugins, "word", "NeoReadCite.applescript"),
          script,
        );
      if (script && word.script)
        await wordFileOperation(word.script, options, async () => {
          await mkdir(dirname(word.script), { recursive: true });
          await copyFile(script, word.script);
          await rm(join(dirname(word.script), "ReaderCite.scpt"), {
            force: true,
          });
        });
      for (const target of word.templates) {
        if (
          options.platform === "win32" &&
          /(?:^|[\\/])Program Files(?: \(x86\))?[\\/]/i.test(target)
        )
          throw new Error(
            "Word 启动目录指向 Program Files，请在 Word 的文件位置设置中恢复用户启动目录后重试",
          );
        await wordFileOperation(target, options, async () => {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(template, target);
          // Remove the former template only after its replacement is installed.
          await rm(join(dirname(target), "Reader.dotm"), { force: true });
        });
      }
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
    return;
  }
  const folder = wpsFolder(options);
  if (!folder) throw new Error("当前系统暂不支持 WPS 插件");
  const keyPath = join(options.appData, "NeoRead", "cite-wps-key");
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  // WPS appends ribbon.xml/index.html; protect the installation base path.
  let key = await readFile(keyPath, "utf8").catch(() =>
    readFile(join(options.appData, "Reader", "cite-wps-key"), "utf8").catch(
      () => "",
    ),
  );
  if (!/^[a-f0-9]{64}$/.test(key)) {
    key = randomBytes(32).toString("hex");
  }
  await writeFile(keyPath, key, { mode: 0o600 });
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
    const word = await wordLocations(options);
    if (!word) return;
    for (const target of word.templates)
      await wordFileOperation(target, options, () =>
        rm(target, { force: true }),
      );
    if (word.script)
      await wordFileOperation(word.script, options, () =>
        rm(word.script, { force: true }),
      );
    return;
  }
  const folder = wpsFolder(options);
  if (!folder) return;
  for (const file of ["jsplugins", "publish"]) {
    const path = join(folder, `${file}.xml`);
    const xml = await readFile(path, "utf8").catch(() => null);
    if (xml !== null) await writeFile(path, unregisterWPS(xml));
  }
  await rm(join(options.appData, "NeoRead", "cite-wps-key"), { force: true });
}
