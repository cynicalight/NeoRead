import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type StartupAppearance = "system" | "light" | "sepia" | "dark";
const valid = (value: unknown): value is StartupAppearance =>
  value === "system" ||
  value === "light" ||
  value === "sepia" ||
  value === "dark";
const filename = "startup-appearance.json";

/** A tiny local hint; authoritative reader settings still come from the library. */
export function readStartupAppearance(directory: string): StartupAppearance {
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, filename), "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256) return "system";
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const appearance = (value as { appearance?: unknown })?.appearance;
    return valid(appearance) ? appearance : "system";
  } catch {
    return "system";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let pending = Promise.resolve();
export function saveStartupAppearance(directory: string, appearance: unknown) {
  const value = valid(appearance) ? appearance : "system";
  // Serialize changes so an older write cannot replace the user's latest choice.
  pending = pending
    .catch(() => {})
    .then(async () => {
      await mkdir(directory, { recursive: true });
      const target = join(directory, filename);
      const temporary = `${target}.tmp`;
      await writeFile(temporary, JSON.stringify({ appearance: value }), {
        mode: 0o600,
      });
      await rename(temporary, target);
    });
  return pending;
}
