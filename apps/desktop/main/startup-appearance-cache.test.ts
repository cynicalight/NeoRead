import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  readStartupAppearance,
  saveStartupAppearance,
} from "./startup-appearance-cache";

it("persists the last chosen appearance and falls back safely for missing/corrupt cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neoread-startup-theme-"));
  try {
    expect(readStartupAppearance(directory)).toBe("system");
    await Promise.all([
      saveStartupAppearance(directory, "dark"),
      saveStartupAppearance(directory, "light"),
    ]);
    expect(readStartupAppearance(directory)).toBe("light");
    expect(
      JSON.parse(
        await readFile(join(directory, "startup-appearance.json"), "utf8"),
      ),
    ).toEqual({ appearance: "light" });
    await writeFile(join(directory, "startup-appearance.json"), "broken");
    expect(readStartupAppearance(directory)).toBe("system");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
