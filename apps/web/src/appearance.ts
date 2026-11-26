import { useMemo, useSyncExternalStore } from "react";
import { defaultTheme, validBrandColor, type ReaderTheme } from "@neoread/core";
const query = "(prefers-color-scheme: dark)";

type BrandMode = keyof NonNullable<ReaderTheme["brandColors"]>;
type ThemePalette = Pick<ReaderTheme, "mode" | "pdfDarkContrast" | "brandColors">;

// Native color inputs need sRGB hex; the grays match the CSS OKLCH defaults.
const defaultBrandColors: Record<BrandMode, string> = {
  light: "#1e1e1e",
  sepia: "#c2643e",
  dark: "#e4dfda",
  black: "#e4e4e4",
};

function brandForeground(color: string, sepia: boolean) {
  const rgb = Number.parseInt(color.slice(1), 16);
  const linear = (value: number, surface: number) => {
    const channel = (sepia ? value * 0.9 + surface * 0.1 : value) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  // Paper's primary is 90% opaque on its #f7f6f2 surface.
  const luminance =
    0.2126 * linear(rgb >> 16, 247) +
    0.7152 * linear((rgb >> 8) & 255, 246) +
    0.0722 * linear(rgb & 255, 242);
  // Pick the higher WCAG contrast ratio against black or white.
  return luminance >= Math.sqrt(1.05 * 0.05) - 0.05 ? "#000000" : "#ffffff";
}

export function themeBrandColor(theme: ThemePalette) {
  const mode: BrandMode =
    theme.mode === "dark" && theme.pdfDarkContrast === "high"
      ? "black"
      : theme.mode;
  const saved = theme.brandColors?.[mode];
  return {
    mode,
    defaultColor: defaultBrandColors[mode],
    customColor: validBrandColor(saved) ? saved : undefined,
  };
}

export function applyDocumentTheme(theme: ThemePalette) {
  const dark = theme.mode === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = theme.mode;
  if (dark) root.dataset.darkContrast = theme.pdfDarkContrast ?? "soft";
  else delete root.dataset.darkContrast;
  root.style.colorScheme = dark ? "dark" : "light";
  const { customColor } = themeBrandColor(theme);
  if (customColor) {
    root.style.setProperty("--brand", customColor);
    root.style.setProperty(
      "--primary-foreground",
      brandForeground(customColor, theme.mode === "sepia"),
    );
  } else {
    root.style.removeProperty("--brand");
    root.style.removeProperty("--primary-foreground");
  }
}

/** Run before mounting React so its first effect uses the native window's theme. */
export function initialDesktopTheme(
  appearance: Partial<ReaderTheme>,
  systemDark: boolean,
) {
  const theme = { ...defaultTheme, ...appearance };
  applyDocumentTheme(resolveTheme(theme, systemDark));
  return theme;
}
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
  if (appearance === "system")
    return systemDark
      ? {
          ...theme,
          mode: "dark",
          pdfDarkContrast: theme.systemDarkContrast ?? "soft",
        }
      : { ...theme, mode: theme.systemLightMode ?? "light" };
  const mode =
    appearance === "dark"
      ? "dark"
      : // Older settings kept paper as light appearance plus a sepia mode.
        appearance === "sepia" || theme.mode === "sepia"
        ? "sepia"
        : "light";
  return { ...theme, mode };
}

/** Graphite and pure black are both the dark appearance, told apart by PDF contrast. */
export type AppearanceChoice =
  "light" | "sepia" | "graphite" | "black" | "system";
export const appearanceChoices: [AppearanceChoice, string][] = [
  ["light", "浅色"],
  ["sepia", "纸张"],
  ["graphite", "石墨"],
  ["black", "纯黑"],
  ["system", "跟随系统"],
];
export function appearanceChoice(theme: ReaderTheme): AppearanceChoice {
  const appearance = theme.appearance ?? "system";
  if (appearance === "system") return "system";
  if (appearance === "dark")
    return theme.pdfDarkContrast === "high" ? "black" : "graphite";
  return appearance === "sepia" || theme.mode === "sepia" ? "sepia" : "light";
}
export function chooseAppearance(
  choice: AppearanceChoice,
): Partial<ReaderTheme> {
  if (choice === "system") return { appearance: "system" };
  if (choice === "graphite" || choice === "black")
    return {
      appearance: "dark",
      mode: "dark",
      pdfDarkContrast: choice === "black" ? "high" : "soft",
    };
  return { appearance: choice, mode: choice };
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

/** Rendered text inset in px from each side of its reading pane. */
export const READING_MARGIN = { min: 0, max: 96, step: 4 };

/** EPUB source size as a percentage of the default size. */
export const epubSizePercent = (fontSize: number) =>
  Math.round((fontSize / defaultTheme.fontSize) * 100);
export const epubFontSize = (percent: number) =>
  Math.round((percent / 100) * defaultTheme.fontSize * 1000) / 1000;

/** CSS font-family for reflowable source text. */
export const sourceFont = (family = defaultTheme.fontFamily) =>
  family === "serif" || family === "sans-serif"
    ? family
    : `"${family.replace(/["\\]/g, "")}", serif`;

export const translationFontLabel = (
  family = defaultTheme.translationFontFamily ?? "serif",
) =>
  family === "sans-serif"
    ? "黑体 / 无衬线"
    : family === "serif"
      ? "宋体 / 衬线"
      : family;
