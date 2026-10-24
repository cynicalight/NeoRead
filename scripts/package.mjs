import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "apps/desktop");
const staging = join(desktop, "staging");
const processor = join(staging, "processor");
if (!["darwin", "win32"].includes(process.platform))
  throw new Error(
    "Installers must be built on a native macOS or Windows runner.",
  );
if (
  !["arm64", "x64"].includes(process.arch) ||
  (process.platform === "win32" && process.arch !== "x64")
)
  throw new Error(
    `Unsupported native target: ${process.platform}/${process.arch}`,
  );
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run with pnpm package or pnpm package:dir.");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const app = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
if (manifest.version !== app.version)
  throw new Error("Root and desktop versions must match.");
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${app.version}`)
  throw new Error(
    `Release tag must be v${app.version}, got ${process.env.RELEASE_TAG}`,
  );

run(process.execPath, [pnpm, "build"]);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
run(process.execPath, [
  pnpm,
  "--filter",
  "@neoread/processor",
  "deploy",
  "--prod",
  "--config.inject-workspace-packages=true",
  "--config.node-linker=hoisted",
  processor,
]);
run(process.execPath, [
  pnpm,
  "--filter",
  "@neoread/agent",
  "deploy",
  "--prod",
  "--config.inject-workspace-packages=true",
  "--config.node-linker=hoisted",
  join(staging, "agent"),
]);
await cp(
  join(root, "scripts/agent-smoke.mjs"),
  join(staging, "agent/smoke.mjs"),
);
// Include lazy worker/shared chunks as well as entrypoints and the model.
await cp(join(processor, "dist"), processor, { recursive: true });
await rm(join(processor, "dist"), { recursive: true });
await cp(
  join(root, "scripts/processor-smoke.mjs"),
  join(processor, "smoke.mjs"),
);
await cp(join(root, "apps/web/dist"), join(staging, "web"), {
  recursive: true,
});
// Citation plugins: the WPS add-in served by Reader and the Word template.
const plugins = join(root, "apps/cite-plugins");
await cp(join(plugins, "wps"), join(staging, "cite-plugins/wps"), {
  recursive: true,
  filter: (source) => !/\.test\.[cm]?[jt]s$/.test(source),
});
await mkdir(join(staging, "cite-plugins/word"), { recursive: true });
await cp(
  join(plugins, "word/ReaderCite.applescript"),
  join(staging, "cite-plugins/word/ReaderCite.applescript"),
);
await cp(
  join(plugins, "word/Reader.dotm"),
  join(staging, "cite-plugins/word/Reader.dotm"),
).catch(() =>
  console.warn("Reader.dotm is missing; the Word plugin is not packaged."),
);
await mkdir(join(staging, "bin"));
for (const name of ["neoread-server", "neoread"]) {
  const binary = `${name}${process.platform === "win32" ? ".exe" : ""}`;
  await cp(join(desktop, "bin", binary), join(staging, "bin", binary));
}
// onnxruntime-node ships other platforms too. Keep the native runner's ABI only.
const nativeRoot = join(processor, "node_modules/onnxruntime-node/bin/napi-v6");
for (const platform of await readdir(nativeRoot)) {
  if (platform !== process.platform)
    await rm(join(nativeRoot, platform), { recursive: true });
  else
    for (const arch of await readdir(join(nativeRoot, platform))) {
      if (arch !== process.arch)
        await rm(join(nativeRoot, platform, arch), { recursive: true });
    }
}
run(
  process.execPath,
  [
    pnpm,
    "exec",
    "electron-builder",
    "--config",
    "builder.config.cjs",
    "--publish",
    "never",
    `--${process.arch}`,
    ...(process.argv.includes("--dir") ? ["--dir"] : []),
  ],
  desktop,
);
if (process.platform === "darwin" && !process.argv.includes("--dir")) {
  // LZMA needs macOS 10.15, below Electron's minimum; it is about a quarter
  // smaller than the builder's zlib or bzip2 images.
  const dmg = join(
    root,
    "release",
    `NeoRead-${app.version}-mac-${process.arch === "x64" ? "intel-x64" : process.arch}.dmg`,
  );
  const compressed = `${dmg}.ulmo.dmg`;
  await rm(compressed, { force: true });
  run("hdiutil", [
    "convert",
    dmg,
    "-format",
    "ULMO",
    "-quiet",
    "-o",
    compressed,
  ]);
  await rename(compressed, dmg);
}
run(process.execPath, [join(root, "scripts/package-smoke.mjs")]);
