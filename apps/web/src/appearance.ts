import { useMemo, useSyncExternalStore } from "react";
import { defaultTheme, type ReaderTheme } from "@reader/core";
const query = "(prefers-color-scheme: dark)";
function subscribe(callback: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
export function resolveTheme(
  theme: ReaderTheme,
  systemDark: boolean,
): ReaderTheme {
  const appearance = theme.appearance ?? "system";
  const mode =
    appearance === "system"
      ? systemDark
        ? "dark"
        : "light"
      : appearance === "dark"
        ? "dark"
        : // Older settings kept paper as light appearance plus a sepia mode.
          appearance === "sepia" || theme.mode === "sepia"
          ? "sepia"
          : "light";
  return { ...theme, mode };
}
export function useResolvedTheme(theme: ReaderTheme) {
  const dark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
  return useMemo(() => resolveTheme(theme, dark), [theme, dark]);
}

/** Reading text size, 80–160% in 5% steps. */
export function stepReadingTextSize(size: number, by: -1 | 1) {
  return Math.min(
    1.6,
    Math.max(0.8, Math.round((size + by * 0.05) * 100) / 100),
  );
}
export const stepTranslationSize = stepReadingTextSize;

const serifStack =
  '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", ui-serif, serif';

/** CSS font-family for translated text; installed fonts fall back to sans. */
export function translationFont(
  family = defaultTheme.translationFontFamily ?? "serif",
) {
  if (family === "sans-serif") return "inherit";
  if (family === "serif") return serifStack;
  return `"${family.replace(/["\\]/g, "")}", system-ui, sans-serif`;
}

export const translationFontLabel = (
  family = defaultTheme.translationFontFamily ?? "serif",
) =>
  family === "sans-serif"
    ? "黑体 / 无衬线"
    : family === "serif"
      ? "宋体 / 衬线"
      : family;
