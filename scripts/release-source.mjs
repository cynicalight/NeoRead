import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = JSON.parse(await readFile("package.json", "utf8"));
const app = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
assert.equal(root.version, app.version, "Root and desktop versions must match");
assert.match(
  app.version,
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  "Invalid release version",
);
if (process.env.RELEASE_TAG)
  assert.equal(
    process.env.RELEASE_TAG,
    `v${app.version}`,
    "Release tag must match app version",
  );
const releaseNotes = JSON.parse(
  await readFile("docs/release-notes.json", "utf8"),
);
const items = releaseNotes[app.version];
assert.ok(
  Array.isArray(items) && items.length > 0,
  `Update docs/release-notes.json for version ${app.version} before releasing`,
);
for (const item of items) {
  assert.ok(
    item &&
      typeof item.title === "string" &&
      item.title.trim() &&
      (item.body === undefined ||
        (typeof item.body === "string" && item.body.trim())) &&
      (item.topic === undefined ||
        (typeof item.topic === "string" && item.topic.trim())),
    "Release notes require a non-empty title and optional non-empty body/topic",
  );
}
console.log(`Validated NeoRead ${app.version} version and release notes`);
