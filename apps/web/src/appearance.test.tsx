// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultTheme, type ReaderTheme } from "@neoread/core";
import {
  appearanceChoice,
  initialDesktopTheme,
  applyDocumentTheme,
  chooseAppearance,
  resolveTheme,
  stepTranslationSize,
  useResolvedTheme,
} from "./appearance";
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  applyDocumentTheme(defaultTheme);
});
it("applies the saved desktop appearance before React mounts, even when the OS differs", () => {
  const theme = initialDesktopTheme(
    { appearance: "dark", pdfDarkContrast: "high" },
    false,
  );
  expect(theme.appearance).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.dataset.darkContrast).toBe("high");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  // React resolves the same seeded state and cannot overwrite it with system defaults.
  applyDocumentTheme(resolveTheme(theme, false));
  expect(document.documentElement.dataset.theme).toBe("dark");
  initialDesktopTheme(
    { appearance: "system", systemLightMode: "sepia" },
    false,
  );
  expect(document.documentElement.dataset.theme).toBe("sepia");
  expect(document.documentElement.dataset.darkContrast).toBeUndefined();
});
it("resolves explicit appearance independently from OS and preserves paper mode", () => {
  expect(
    resolveTheme({ ...defaultTheme, appearance: "light" }, true).mode,
  ).toBe("light");
  expect(
    resolveTheme({ ...defaultTheme, appearance: "dark" }, false).mode,
  ).toBe("dark");
  expect(
    resolveTheme({ ...defaultTheme, appearance: "light", mode: "sepia" }, true)
      .mode,
  ).toBe("sepia");
  expect(
    resolveTheme({ ...defaultTheme, appearance: "sepia" }, true).mode,
  ).toBe("sepia");
});
it("uses the chosen palettes while following the system", () => {
  const theme = {
    ...defaultTheme,
    appearance: "system" as const,
    systemLightMode: "sepia" as const,
    systemDarkContrast: "high" as const,
    pdfDarkContrast: "soft" as const,
  };
  expect(resolveTheme(theme, false).mode).toBe("sepia");
  expect(resolveTheme(theme, true)).toMatchObject({
    mode: "dark",
    pdfDarkContrast: "high",
  });
  expect(resolveTheme({ ...defaultTheme }, true).pdfDarkContrast).toBe("soft");
});
it("maps the five appearance choices to settings and back", () => {
  for (const choice of [
    "light",
    "sepia",
    "graphite",
    "black",
    "system",
  ] as const)
    expect(
      appearanceChoice({ ...defaultTheme, ...chooseAppearance(choice) }),
    ).toBe(choice);
  expect(
    appearanceChoice({ ...defaultTheme, appearance: "light", mode: "sepia" }),
  ).toBe("sepia");
});
it("steps translated text size within bounds", () => {
  expect(stepTranslationSize(1, 1)).toBe(1.05);
  expect(stepTranslationSize(0.8, -1)).toBe(0.8);
  expect(stepTranslationSize(1.6, 1)).toBe(1.6);
});
it("follows live system changes and unsubscribes on unmount", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let matches = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }));
  const host = document.createElement("div");
  root = createRoot(host);
  function Theme({ theme }: { theme: ReaderTheme }) {
    return <span>{useResolvedTheme(theme).mode}</span>;
  }
  act(() => root!.render(<Theme theme={defaultTheme} />));
  expect(host.textContent).toBe("light");
  act(() => {
    matches = true;
    listeners.forEach((cb) => cb());
  });
  expect(host.textContent).toBe("dark");
  act(() =>
    root!.render(<Theme theme={{ ...defaultTheme, appearance: "light" }} />),
  );
  expect(host.textContent).toBe("light");
  act(() => root!.unmount());
  root = undefined;
  expect(listeners.size).toBe(0);
});
