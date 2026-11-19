import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const { version } = JSON.parse(
  await readFile("apps/desktop/package.json", "utf8"),
);
const expected = [
  `NeoRead-${version}-mac-arm64.dmg`,
  `NeoRead-${version}-mac-arm64.zip`,
  `NeoRead-${version}-mac-intel-x64.dmg`,
  `NeoRead-${version}-mac-intel-x64.zip`,
  ...(process.env.MAC_ONLY === "true" ? [] : [`NeoRead-${version}-win-x64.exe`]),
].sort();
const actual = (await readdir("release"))
  .filter((file) => file !== "SHA256SUMS.txt")
  .sort();
assert.deepEqual(
  actual,
  expected,
  "Release must contain exactly the installers selected for this release",
);
const checksums = [];
for (const file of expected) {
  const bytes = await readFile(`release/${file}`);
  assert.ok(
    bytes.length > 1024 * 1024,
    `Installer is unexpectedly small: ${file}`,
  );
  const [header, magic] = file.endsWith(".dmg")
    ? [bytes.subarray(-512, -508), "koly"]
    : file.endsWith(".zip")
      ? [bytes.subarray(0, 4), "PK\u0003\u0004"]
      : [bytes.subarray(0, 2), "MZ"];
  assert.equal(header.toString(), magic, `Invalid installer format: ${file}`);
  checksums.push(
    `${createHash("sha256").update(bytes).digest("hex")}  ${file}`,
  );
}
await writeFile("release/SHA256SUMS.txt", checksums.join("\n") + "\n");
console.log(checksums.join("\n"));
if (process.argv.includes("--upload")) {
  assert.equal(
    process.env.RELEASE_TAG,
    `v${version}`,
    "Release tag must match app version",
  );
  // Publish the discovery manifest only after every installer is available.
  for (const files of [expected, ["SHA256SUMS.txt"]]) {
    const result = spawnSync(
      "gh",
      [
        "release",
        "upload",
        process.env.RELEASE_TAG,
        ...files.map((file) => `release/${file}`),
        "--clobber",
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
