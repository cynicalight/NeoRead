import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const scripts = dirname(fileURLToPath(import.meta.url));
const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "neoread-release-test-"));
  temporary.push(cwd);
  await mkdir(join(cwd, "apps/desktop"), { recursive: true });
  await mkdir(join(cwd, "release"));
  for (const path of ["package.json", "apps/desktop/package.json"])
    await writeFile(join(cwd, path), JSON.stringify({ version: "0.2.0" }));
  return cwd;
}
function run(script, cwd, env = {}, args = []) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: "",
      GITHUB_OUTPUT: "",
      MAC_ONLY: "false",
      ...env,
    },
    timeout: 10000,
  });
}
async function installers(cwd) {
  const files = [];
  for (const target of [
    "mac-arm64.dmg",
    "mac-arm64.zip",
    "mac-intel-x64.dmg",
    "mac-intel-x64.zip",
    "win-x64.exe",
  ]) {
    const file = `NeoRead-0.2.0-${target}`;
    const bytes = Buffer.alloc(1024 * 1024 + 512);
    if (target.endsWith("dmg")) bytes.write("koly", bytes.length - 512);
    else if (target.endsWith("zip")) bytes.write("PK\u0003\u0004", 0);
    else bytes.write("MZ", 0);
    await writeFile(join(cwd, "release", file), bytes);
    files.push({ file, bytes });
  }
  return files;
}
test("release refuses a version mismatch before building", async () => {
  const cwd = await fixture();
  const tag = run("release-source.mjs", cwd, { RELEASE_TAG: "v9.9.9" });
  expect(tag.status).not.toBe(0);
  expect(tag.stderr).toContain("Release tag must match app version");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ version: "0.3.0" }),
  );
  const manifests = run("release-source.mjs", cwd);
  expect(manifests.status).not.toBe(0);
  expect(manifests.stderr).toContain("Root and desktop versions must match");
});
test.each([{}, { "0.2.0": [] }, { "0.2.0": [{ title: " " }] }])(
  "release refuses missing or empty current-version notes: %j",
  async (notes) => {
    const cwd = await fixture();
    await mkdir(join(cwd, "docs"));
    await writeFile(
      join(cwd, "docs/release-notes.json"),
      JSON.stringify(notes),
    );
    const result = run("release-source.mjs", cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /Update docs\/release-notes.json|Release notes require/,
    );
  },
);
test("release refuses missing or unexpected artifacts", async () => {
  const cwd = await fixture();
  expect(run("release-assets.mjs", cwd).status).not.toBe(0);
  await installers(cwd);
  await rm(join(cwd, "release/NeoRead-0.2.0-win-x64.exe"));
  expect(run("release-assets.mjs", cwd).status).not.toBe(0);
  await installers(cwd);
  await rm(join(cwd, "release/NeoRead-0.2.0-mac-arm64.zip"));
  expect(run("release-assets.mjs", cwd, { MAC_ONLY: "true" }).status).not.toBe(
    0,
  );
  expect(run("release-assets.mjs", cwd).status).not.toBe(0);
  await installers(cwd);
  await writeFile(join(cwd, "release/NeoRead-0.2.0-mac-x64.dmg"), "unexpected");
  expect(run("release-assets.mjs", cwd).status).not.toBe(0);
});
test("release checks installer format before writing hashes", async () => {
  const cwd = await fixture();
  const files = await installers(cwd);
  await writeFile(
    join(cwd, "release", files[0].file),
    Buffer.alloc(1024 * 1024 + 512),
  );
  const result = run("release-assets.mjs", cwd);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Invalid installer format");
});
test("Mac-only release requires both architectures' DMG and update ZIP", async () => {
  const cwd = await fixture();
  const files = await installers(cwd);
  await rm(join(cwd, "release/NeoRead-0.2.0-win-x64.exe"));
  expect(run("release-assets.mjs", cwd).status).not.toBe(0);
  const intelZip = join(cwd, "release/NeoRead-0.2.0-mac-intel-x64.zip");
  await rm(intelZip);
  expect(run("release-assets.mjs", cwd, { MAC_ONLY: "true" }).status).not.toBe(0);
  await writeFile(
    intelZip,
    files.find(({ file }) => file.endsWith("intel-x64.zip")).bytes,
  );
  expect(run("release-assets.mjs", cwd, { MAC_ONLY: "true" }).status).toBe(0);
  const hashes = await readFile(join(cwd, "release/SHA256SUMS.txt"), "utf8");
  expect(hashes.split("\n").filter(Boolean)).toHaveLength(4);
  for (const { file, bytes } of files.filter(
    ({ file }) => !file.endsWith(".exe"),
  ))
    expect(hashes).toContain(
      `${createHash("sha256").update(bytes).digest("hex")}  ${file}\n`,
    );
  await writeFile(
    join(cwd, "release/NeoRead-0.2.0-win-x64.exe"),
    files.find(({ file }) => file.endsWith(".exe")).bytes,
  );
  expect(run("release-assets.mjs", cwd, { MAC_ONLY: "true" }).status).not.toBe(
    0,
  );
});
test("complete artifacts get correct hashes and upload requires the matching tag", async () => {
  const cwd = await fixture();
  const files = await installers(cwd);
  expect(run("release-assets.mjs", cwd).status).toBe(0);
  const hashes = await readFile(join(cwd, "release/SHA256SUMS.txt"), "utf8");
  for (const { file, bytes } of files)
    expect(hashes).toContain(
      `${createHash("sha256").update(bytes).digest("hex")}  ${file}\n`,
    );
  const upload = run("release-assets.mjs", cwd, { RELEASE_TAG: "v0.3.0" }, [
    "--upload",
  ]);
  expect(upload.status).not.toBe(0);
  expect(upload.stderr).toContain("Release tag must match app version");
});

// Intercept only the external gh process; execute the real release script,
// including its file validation, hashing, upload ordering and exit status.
test.each([0, 1, 2])(
  "publishes checksums last and stops on upload failure %s",
  async (failAt) => {
    const cwd = await fixture();
    await installers(cwd);
    const hook = join(cwd, "gh-hook.mjs");
    await writeFile(
      hook,
      `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { appendFileSync } from "node:fs";
    let count = 0;
    cp.spawnSync = (command, args) => {
      if (command !== "gh") throw new Error("Unexpected subprocess");
      appendFileSync("uploads.jsonl", JSON.stringify(args) + "\\n");
      return { status: ++count === ${failAt} ? 1 : 0 };
    };
    syncBuiltinESMExports();
  `,
    );
    const result = run(
      "release-assets.mjs",
      cwd,
      {
        RELEASE_TAG: "v0.2.0",
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
      },
      ["--upload"],
    );
    expect(result.status, result.stderr).toBe(failAt ? 1 : 0);
    const uploads = (await readFile(join(cwd, "uploads.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(uploads[0]).toEqual([
      "release",
      "upload",
      "v0.2.0",
      "release/NeoRead-0.2.0-mac-arm64.dmg",
      "release/NeoRead-0.2.0-mac-arm64.zip",
      "release/NeoRead-0.2.0-mac-intel-x64.dmg",
      "release/NeoRead-0.2.0-mac-intel-x64.zip",
      "release/NeoRead-0.2.0-win-x64.exe",
      "--clobber",
    ]);
    expect(uploads).toHaveLength(failAt === 1 ? 1 : 2);
    if (failAt !== 1)
      expect(uploads[1]).toEqual([
        "release",
        "upload",
        "v0.2.0",
        "release/SHA256SUMS.txt",
        "--clobber",
      ]);
  },
);
