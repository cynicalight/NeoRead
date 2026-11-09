import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === "win32";
const source = windows
  ? join(root, "release/win-unpacked")
  : join(
      root,
      `release/mac${process.arch === "arm64" ? "-arm64" : ""}/NeoRead.app`,
    );
const temporary = await mkdtemp(join(tmpdir(), "neoread-package-smoke-"));
const isolated = join(temporary, windows ? "NeoRead" : "NeoRead.app");
const app = windows ? isolated : join(isolated, "Contents");
const resources = join(app, windows ? "resources" : "Resources");
const electron = join(app, windows ? "NeoRead.exe" : "MacOS/NeoRead");
let child;
let stopped;
try {
  // Node resolves modules relative to the script, regardless of cwd. Relocate the
  // whole app so a missing packaged dependency cannot fall back to the checkout.
  await cp(source, isolated, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  if (!windows) {
    const signature = spawnSync(
      "codesign",
      ["--verify", "--deep", "--strict", dirname(app)],
      { stdio: "inherit" },
    );
    if (signature.error) throw signature.error;
    assert.equal(signature.status, 0, "Packaged signature is invalid");
    if (process.env.RELEASE_TAG) {
      const details = spawnSync("codesign", ["-dvv", dirname(app)], {
        encoding: "utf8",
      });
      assert.equal(details.status, 0, details.stderr);
      assert.match(
        details.stderr,
        /^Authority=NeoRead Self-Signed$/m,
        "Release must be signed with the fixed NeoRead certificate",
      );
    }
  }
  const native = spawnSync(electron, [join(resources, "processor/smoke.mjs")], {
    cwd: temporary,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: 60000,
  });
  if (native.error) throw native.error;
  assert.equal(native.status, 0, "Packaged native processor smoke failed");
  const agent = spawnSync(electron, [join(resources, "agent.asar/smoke.mjs")], {
    cwd: temporary,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: 30_000,
  });
  if (agent.error) throw agent.error;
  assert.equal(agent.status, 0, "Packaged pi worker smoke failed");
  const token = randomBytes(32).toString("hex");
  child = spawn(
    join(resources, "bin", `neoread-server${windows ? ".exe" : ""}`),
    [
      "--port",
      "0",
      "--connector=false",
      "--data",
      join(temporary, "library"),
      "--web",
      join(resources, "web"),
    ],
    {
      cwd: temporary,
      env: {
        ...process.env,
        NEOREAD_TOKEN: token,
        NEOREAD_NODE: electron,
        NEOREAD_AGENT: join(resources, "agent.asar/dist/main.mjs"),
        NEOREAD_PROCESSOR: join(resources, "processor/main.mjs"),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  stopped = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Packaged sidecar readiness timeout")),
      20000,
    );
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Sidecar exited: ${code}`)));
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });
  lines.close();
  assert.equal(new URL(ready.url).hostname, "127.0.0.1");
  const request = (path, authorized = true) =>
    fetch(ready.url + path, {
      headers: authorized ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    });
  assert.equal((await request("/api/documents", false)).status, 401);
  const documents = await request("/api/documents");
  assert.equal(documents.status, 200);
  // A fresh library includes the bundled onboarding paper.
  const library = await documents.json();
  assert.equal(library.length, 1, "Fresh library must contain the example paper");
  assert.equal(library[0].title, "Attention Is All You Need");
  assert.equal(library[0].type, "pdf");
  assert.equal(library[0].metadata.arxiv, "1706.03762");
  const web = await request("/");
  assert.equal(web.status, 200);
  assert.match(await web.text(), /<div id="root">/);
  assert.equal((await request("/samples/reading-notes.pdf")).status, 200);
  // The command line finds the running service through the library directory.
  const cli = spawnSync(
    join(resources, "bin", `neoread${windows ? ".exe" : ""}`),
    ["status", "--json"],
    {
      cwd: temporary,
      env: { ...process.env, NEOREAD_DATA: join(temporary, "library") },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  if (cli.error) throw cli.error;
  assert.equal(cli.status, 0, `Packaged command line failed: ${cli.stderr}`);
  const status = JSON.parse(cli.stdout);
  assert.equal(status.url, ready.url);
  assert.equal(status.documents, library.length);
  console.log(
    "Packaged Go service, SQLite, API authentication, command line and web resources passed.",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
    }
  } else if (stopped) await stopped;
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
