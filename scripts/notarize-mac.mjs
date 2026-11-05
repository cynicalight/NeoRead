// Notarize and staple the macOS release artifacts after packaging.
// Runs on the macOS runner after `pnpm package`: the DMG is already in its
// final ULMO form and the zip is the Squirrel.Mac in-place update payload.
// The notarization must happen after package.mjs because any byte change after
// submission invalidates the ticket.
//
// Credentials (only configured for macOS release builds):
//   NEOREAD_APPLE_P12           Developer ID .p12 (base64) used for signing
//   NEOREAD_APPLE_P12_PASSWORD  its password
//   NEOREAD_APPLE_ID            Apple ID (email) used for notarization
//   NEOREAD_APPLE_PASSWORD      App-specific password, never the account password
//   NEOREAD_APPLE_TEAM_ID       Team ID of the Developer Program membership
// All five must be configured together or none at all; partial configuration
// fails the build so a "signed but not notarized" release cannot slip through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(
  await readFile(join(root, "apps/desktop/package.json"), "utf8"),
);

const p12 = process.env.NEOREAD_APPLE_P12;
const p12Password = process.env.NEOREAD_APPLE_P12_PASSWORD;
const appleId = process.env.NEOREAD_APPLE_ID;
const password = process.env.NEOREAD_APPLE_PASSWORD;
const teamId = process.env.NEOREAD_APPLE_TEAM_ID;
const present = [p12, p12Password, appleId, password, teamId].filter(
  (value) => value,
).length;
if (present === 0) {
  console.log(
    "Apple notarization credentials are not configured; skipping notarization.",
  );
  process.exit(0);
}
assert.equal(
  present,
  5,
  "Set all of NEOREAD_APPLE_P12, NEOREAD_APPLE_P12_PASSWORD, NEOREAD_APPLE_ID, NEOREAD_APPLE_PASSWORD and NEOREAD_APPLE_TEAM_ID, or none of them.",
);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, redact = []) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Never echo secrets into the failure message: they end up in build logs.
    const display = args.map((arg) => (redact.includes(arg) ? "***" : arg));
    throw new Error(
      `${command} ${display.join(" ")} failed (${result.status}):\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function notarize(file) {
  console.log(`Submitting ${file} to Apple notarization...`);
  const out = run(
    "xcrun",
    [
      "notarytool",
      "submit",
      file,
      "--apple-id",
      appleId,
      "--password",
      password,
      "--team-id",
      teamId,
      "--wait",
      "--output-format",
      "json",
    ],
    [password],
  );
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    throw new Error(`Could not parse notarytool output for ${file}:\n${out}`);
  }
  if (report.status !== "Accepted") {
    throw new Error(
      `Notarization rejected for ${file} (${report.status}): ${report.message ?? ""} ${report.logFileUrl ?? ""}`,
    );
  }
  console.log(`Notarization accepted for ${file} (${report.id}).`);
}

const arch = process.arch === "x64" ? "intel-x64" : process.arch;
const app = join(
  root,
  "release",
  `mac${process.arch === "arm64" ? "-arm64" : ""}`,
  "NeoRead.app",
);
const dmg = join(root, "release", `NeoRead-${version}-mac-${arch}.dmg`);
const zip = join(root, "release", `NeoRead-${version}-mac-${arch}.zip`);

// Notarize the DMG (the app inside it) and the Squirrel update zip.
for (const file of [dmg, zip]) {
  if (!(await exists(file))) {
    console.log(`Skipping missing artifact ${file}`);
    continue;
  }
  await notarize(file);
}

// Staple the app and the DMG so Gatekeeper passes offline; a zip cannot be
// stapled (its ticket stays retrievable from Apple's servers).
if (await exists(app)) {
  run("xcrun", ["stapler", "staple", app]);
  run("xcrun", ["stapler", "validate", app]);
}
if (await exists(dmg)) {
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
}

console.log("Apple notarization and stapling complete.");
