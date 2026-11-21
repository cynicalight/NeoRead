import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  for (const path of ["package.json", "apps/desktop/package.json"])
    await writeFile(join(cwd, path), JSON.stringify({ version: "0.2.0" }));
  return cwd;
}
function run(cwd, env = {}) {
  return spawnSync(process.execPath, [join(scripts, "release-source.mjs")], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: "",
      ...env,
    },
    timeout: 10000,
  });
}
test("release source validation refuses a version mismatch", async () => {
  const cwd = await fixture();
  const tag = run(cwd, { RELEASE_TAG: "v9.9.9" });
  expect(tag.status).not.toBe(0);
  expect(tag.stderr).toContain("Release tag must match app version");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ version: "0.3.0" }),
  );
  const manifests = run(cwd);
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
    const result = run(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /Update docs\/release-notes.json|Release notes require/,
    );
  },
);
