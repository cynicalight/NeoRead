import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("electron", () => ({ dialog: {} }));
import { detectReaderMigration, declineReaderMigration } from "./legacy-data";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "neoread-detection-"));
  roots.push(root);
  const target = join(root, "NeoRead");
  await mkdir(join(root, "Reader", "library"), { recursive: true });
  return { root, target };
}
it("detects legacy data without creating target, locks or records", async () => {
  const { root, target } = await fixture();
  expect(await detectReaderMigration(root, target)).toBe("required");
  expect(await readdir(root)).toEqual(["Reader"]);
  expect(await readdir(join(root, "Reader"))).toEqual(["library"]);
});
it.each(["copying", "verified", "completed", "not-needed"])(
  "handles journal state %s before checking existing data",
  async (status) => {
    const { root, target } = await fixture();
    await mkdir(join(target, "library"), { recursive: true });
    const contents = JSON.stringify({
      schemaVersion: 1,
      migrations: { "reader-to-neoread": { status } },
    });
    await writeFile(join(target, "migrations.json"), contents);
    expect(await detectReaderMigration(root, target)).toBe(
      ["copying", "verified"].includes(status) ? "resume" : "none",
    );
    expect(await readdir(target)).toEqual(["library", "migrations.json"]);
  },
);
it.each([
  "invalid",
  '{"schemaVersion":2}',
  '{"schemaVersion":1,"migrations":{"reader-to-neoread":{"status":"unknown"}}}',
])("fails closed for invalid records", async (contents) => {
  const { root, target } = await fixture();
  await mkdir(target);
  await writeFile(join(target, "migrations.json"), contents);
  await expect(detectReaderMigration(root, target)).rejects.toThrow(
    "无法读取迁移记录",
  );
});
it("does not prompt for existing NeoRead data or a fresh install", async () => {
  const { root, target } = await fixture();
  await mkdir(join(target, "library"), { recursive: true });
  expect(await detectReaderMigration(root, target)).toBe("none");
  await rm(join(root, "Reader"), { recursive: true });
  await rm(target, { recursive: true });
  expect(await detectReaderMigration(root, target)).toBe("none");
});

it.each([undefined, "copying", "verified"])("remembers rejection across restarts without replacing %s progress", async (status) => {
  const { root, target } = await fixture();
  const state = status ? { status, entries: { library: "original-digest" }, source: "/original" } : undefined;
  if (state) {
    await mkdir(target);
    await writeFile(join(target, "migrations.json"), JSON.stringify({
      schemaVersion: 1, migrations: { "reader-to-neoread": state, other: { status: "completed" } },
    }));
  }
  await declineReaderMigration(target);
  expect(await detectReaderMigration(root, target)).toBe("declined");
  await mkdir(join(target, "library"));
  expect(await detectReaderMigration(root, target)).toBe("declined");
  const record = JSON.parse(await readFile(join(target, "migrations.json"), "utf8"));
  expect(record.readerMigrationDecision).toBe("declined");
  expect(record.migrations["reader-to-neoread"]).toEqual(state);
  if (state) expect(record.migrations.other).toEqual({ status: "completed" });
  expect((await readdir(target)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
it("does not overwrite a damaged journal when saving rejection", async () => {
  const { target } = await fixture();
  await mkdir(target);
  await writeFile(join(target, "migrations.json"), "broken");
  await expect(declineReaderMigration(target)).rejects.toThrow();
  expect(await readFile(join(target, "migrations.json"), "utf8")).toBe("broken");
});
