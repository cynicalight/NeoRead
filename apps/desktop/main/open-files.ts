import { resolve } from "node:path";

export const documentFile = /\.(epub|pdf)$/i;

/**
 * Documents named on a command line, as Windows "Open with" starts NeoRead.
 * Skips the executable, the development entry script, switches and links, and
 * resolves the rest against the launching process's working directory.
 */
export function documentArguments(
  argv: string[],
  workingDirectory: string,
  defaultApp: boolean,
  resolvePath: (...paths: string[]) => string = resolve,
) {
  return argv
    .slice(defaultApp ? 2 : 1)
    .filter(
      (arg) =>
        !arg.startsWith("-") && !arg.includes("://") && documentFile.test(arg),
    )
    .map((arg) => resolvePath(workingDirectory, arg));
}
