import type { ReaderTheme } from "../../packages/neoread-core/src/index";

const prefix = "--neoread-startup-appearance=";
const choices = {
  appearance: ["system", "light", "sepia", "dark"],
  mode: ["light", "sepia", "dark"],
  pdfDarkContrast: ["high", "soft"],
  systemLightMode: ["light", "sepia"],
  systemDarkContrast: ["high", "soft"],
};

/** Only bounded appearance enums enter Chromium's command line, never full settings. */
function appearanceOnly(settings: unknown): Partial<ReaderTheme> {
  if (!settings || typeof settings !== "object") return {};
  return Object.fromEntries(
    Object.entries(choices).flatMap(([key, allowed]) => {
      const value = (settings as Record<string, unknown>)[key];
      return typeof value === "string" && allowed.includes(value)
        ? [[key, value]]
        : [];
    }),
  );
}

export function startupAppearanceArgument(settings: unknown): string {
  return prefix + encodeURIComponent(JSON.stringify(appearanceOnly(settings)));
}

export function startupAppearanceFromArguments(argv: string[]) {
  const argument = argv.find((value) => value.startsWith(prefix));
  if (!argument) return undefined;
  try {
    return appearanceOnly(
      JSON.parse(decodeURIComponent(argument.slice(prefix.length))),
    );
  } catch {
    return undefined;
  }
}
