import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const assetsScript = fileURLToPath(
  new URL("./release-assets.mjs", import.meta.url),
);
const startMarker = "<!-- neoread:r2-downloads:start -->";
const endMarker = "<!-- neoread:r2-downloads:end -->";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readConfig(env, requireCredentials = true) {
  for (const name of ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_PUBLIC_BASE_URL"])
    assert.ok(env[name]?.trim(), `${name} is required`);
  assert.match(
    env.R2_BUCKET,
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    "Invalid R2_BUCKET",
  );
  const endpoint = new URL(env.R2_ENDPOINT_URL);
  const publicURL = new URL(env.R2_PUBLIC_BASE_URL);
  for (const [name, url] of [
    ["R2_ENDPOINT_URL", endpoint],
    ["R2_PUBLIC_BASE_URL", publicURL],
  ]) {
    assert.ok(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
      `${name} must be an HTTPS origin`,
    );
  }
  assert.ok(
    endpoint.hostname.endsWith(".r2.cloudflarestorage.com"),
    "R2_ENDPOINT_URL must be a Cloudflare R2 S3 endpoint",
  );
  if (requireCredentials)
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
      assert.ok(env[name]?.trim(), `${name} is required`);
  return {
    bucket: env.R2_BUCKET,
    endpoint: endpoint.origin,
    publicBase: publicURL.origin,
  };
}

export function replaceDownloadSection(body, markdown) {
  const block = `${startMarker}\n${markdown}\n${endMarker}`;
  const starts = body.split(startMarker).length - 1;
  const ends = body.split(endMarker).length - 1;
  if (!starts && !ends) return `${body.trimEnd()}\n\n${block}\n`;
  assert.ok(
    starts === 1 &&
      ends === 1 &&
      body.indexOf(startMarker) < body.indexOf(endMarker),
    "Malformed R2 download markers in release notes",
  );
  return (
    body.slice(0, body.indexOf(startMarker)) +
    block +
    body.slice(body.indexOf(endMarker) + endMarker.length)
  );
}

async function command(command, args, options) {
  try {
    const { stdout } = await exec(command, args, {
      ...options,
      timeout: 15 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // execFile errors include arguments and child output. Keep credentials,
    // response bodies and release prose out of CI failure diagnostics.
    const code =
      typeof error.code === "number" || error.code === "ENOENT"
        ? error.code
        : "process";
    throw new Error(`${command} failed (code=${code})`);
  }
}

async function verifyPublic(file, url, { request, sleep, log, version }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    let reason = "network";
    try {
      response = await request(url, {
        headers: {
          "User-Agent": `NeoRead/${version} release-ci`,
          "Cache-Control": "no-cache",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60_000),
      });
      reason = "http_status";
      assert.equal(
        response.status,
        200,
        `Public verification returned HTTP ${response.status}`,
      );
      reason = "download_filename";
      assert.equal(
        response.headers.get("Content-Disposition"),
        `attachment; filename="${file.name}"`,
        "Public verification returned an unexpected download filename",
      );
      reason = "missing_body";
      assert.ok(response.body, "Public verification returned no body");
      const hash = createHash("sha256");
      let size = 0;
      reason = "body_read";
      for await (const chunk of response.body) {
        size += chunk.length;
        reason = "size_mismatch";
        assert.ok(
          size <= file.size,
          "Public verification exceeded expected size",
        );
        hash.update(chunk);
        reason = "body_read";
      }
      reason = "size_mismatch";
      assert.equal(size, file.size, "Public verification size mismatch");
      reason = "sha256_mismatch";
      assert.equal(
        hash.digest("hex"),
        file.sha256,
        "Public verification SHA-256 mismatch",
      );
      log({ event: "release.r2_verified", file: file.name, attempt });
      return;
    } catch {
      await response?.body?.cancel().catch(() => {});
      log({
        event: "release.r2_verification_failed",
        file: file.name,
        attempt,
        reason,
        status: response?.status ?? null,
      });
      if (attempt === 3)
        throw new Error(
          `Public verification failed for ${file.name} after 3 attempts (${reason})`,
        );
      await sleep(2000 * attempt);
    }
  }
}

export async function publishR2({
  cwd = process.cwd(),
  env = process.env,
  dryRun = false,
  run = (cmd, args) =>
    command(cmd, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        AWS_DEFAULT_REGION: "auto",
        AWS_RETRY_MODE: "standard",
        AWS_MAX_ATTEMPTS: "3",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_PAGER: "",
      },
    }),
  request = fetch,
  sleep = delay,
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  const config = readConfig(env, !dryRun);
  const { version } = JSON.parse(
    await readFile(join(cwd, "apps/desktop/package.json"), "utf8"),
  );
  assert.match(
    version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    "Invalid app version",
  );
  const tag = env.RELEASE_TAG || (dryRun ? `v${version}` : "");
  assert.equal(tag, `v${version}`, "Release tag must match app version");
  if (!dryRun) {
    assert.ok(env.GH_TOKEN, "GH_TOKEN is required");
    assert.match(
      env.GH_REPO ?? "",
      /^[\w.-]+\/[\w.-]+$/,
      "GH_REPO is required",
    );
  }
  // Reuse the existing exact artifact-set, format and hash checks. No second
  // independently maintained platform allowlist or checksum parser input.
  await command(process.execPath, [assetsScript], {
    cwd,
    env: { ...process.env, ...env },
  });
  const checksumPath = join(cwd, "release/SHA256SUMS.txt");
  const checksumBytes = await readFile(checksumPath);
  const files = [];
  for (const line of checksumBytes.toString("utf8").trim().split("\n")) {
    const [sha256, name] = line.split("  ");
    files.push({
      name,
      sha256,
      path: join(cwd, "release", name),
      size: (await stat(join(cwd, "release", name))).size,
    });
  }
  files.push({
    name: "SHA256SUMS.txt",
    sha256: createHash("sha256").update(checksumBytes).digest("hex"),
    path: checksumPath,
    size: checksumBytes.length,
  });
  const prefix = `neoread/releases/${tag}`;
  const urlFor = (key) => `${config.publicBase}/${key}`;
  const markdown = [
    "### 下载安装包（Cloudflare R2）",
    "",
    ...files.map(
      (file) => `- [${file.name}](${urlFor(`${prefix}/${file.name}`)})`,
    ),
  ].join("\n");
  if (dryRun) {
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `## R2 下载链接预览（未上传）\n\n${markdown}\n`,
      );
    log({ event: "release.r2_preview", version, files: files.length });
    return;
  }
  const release = JSON.parse(
    await run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      env.GH_REPO,
      "--json",
      "body,isDraft,isPrerelease,tagName",
    ]),
  );
  assert.ok(
    release.tagName === tag && release.isDraft === false,
    "Expected a published release with the matching tag",
  );
  assert.equal(
    typeof release.isPrerelease,
    "boolean",
    "Missing release channel",
  );
  replaceDownloadSection(release.body ?? "", markdown);

  const started = Date.now();
  log({ event: "release.r2_started", version, files: files.length });
  let phase = "versioned";
  try {
    async function upload(file, key) {
      log({ event: "release.r2_upload", phase, file: file.name });
      await run("aws", [
        "s3",
        "cp",
        file.path,
        `s3://${config.bucket}/${key}`,
        "--endpoint-url",
        config.endpoint,
        "--region",
        "auto",
        "--only-show-errors",
        "--no-progress",
        "--content-type",
        file.name.endsWith(".txt")
          ? "text/plain; charset=utf-8"
          : "application/octet-stream",
        "--content-disposition",
        `attachment; filename="${file.name}"`,
        "--cache-control",
        "no-cache",
      ]);
      await verifyPublic(file, urlFor(key), { request, sleep, log, version });
    }
    // Publish the version-specific discovery manifest only after installers
    // have been downloaded and verified through the public domain.
    for (const file of files) await upload(file, `${prefix}/${file.name}`);

    phase = "aliases";
    const aliases = [];
    if (!release.isPrerelease && !version.includes("-")) {
      const latest = JSON.parse(
        await run("gh", ["api", `repos/${env.GH_REPO}/releases/latest`]),
      );
      if (latest.tag_name === tag) {
        for (const file of files) {
          const target = file.name.endsWith("-mac-arm64.dmg")
            ? "mac"
            : file.name.endsWith("-win-x64.exe")
              ? "win"
              : null;
          if (!target) continue;
          const key = `neoread/install/${target}`;
          await upload(file, key);
          aliases.push(`- [${target}](${urlFor(key)})`);
        }
      } else
        log({
          event: "release.r2_aliases_skipped",
          reason: "not_latest",
          version,
        });
    } else
      log({
        event: "release.r2_aliases_skipped",
        reason: "prerelease",
        version,
      });

    phase = "links";
    // Re-read after uploads to preserve edits made while installers transferred.
    const current = JSON.parse(
      await run("gh", [
        "release",
        "view",
        tag,
        "--repo",
        env.GH_REPO,
        "--json",
        "body",
      ]),
    );
    const body = replaceDownloadSection(current.body ?? "", markdown);
    const temporary = await mkdtemp(join(tmpdir(), "neoread-release-notes-"));
    try {
      const notes = join(temporary, "notes.md");
      await writeFile(notes, body);
      await run("gh", [
        "release",
        "edit",
        tag,
        "--repo",
        env.GH_REPO,
        "--notes-file",
        notes,
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `${markdown}\n${aliases.length ? `\n已更新固定入口：\n${aliases.join("\n")}\n` : ""}`,
      );
    log({
      event: "release.r2_completed",
      version,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    log({
      event: "release.r2_failed",
      version,
      phase,
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.includes("--check-config")) {
      readConfig(process.env);
      console.log("R2 configuration is present");
    } else await publishR2({ dryRun: process.argv.includes("--dry-run") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
