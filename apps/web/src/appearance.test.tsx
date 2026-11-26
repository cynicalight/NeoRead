// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultTheme, validBrandColor, type ReaderTheme } from "@neoread/core";
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
    {
      appearance: "dark",
      pdfDarkContrast: "high",
      brandColors: { black: "#112233" },
    },
    false,
  );
  expect(theme.appearance).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.dataset.darkContrast).toBe("high");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(document.documentElement.style.getPropertyValue("--brand")).toBe(
    "#112233",
  );
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
it("applies and clears the custom accent for each resolved palette", () => {
  const theme: ReaderTheme = {
    ...defaultTheme,
    systemLightMode: "sepia",
    systemDarkContrast: "high",
    brandColors: {
      light: "#757575",
      sepia: "#757575",
      dark: "#fefefe",
      black: "#001122",
    },
  };
  const style = document.documentElement.style;
  for (const [resolved, expectedColor, expectedForeground] of [
    [resolveTheme({ ...theme, appearance: "light" }, true), "#757575", "#ffffff"],
    [resolveTheme(theme, false), "#757575", "#000000"],
    [
      resolveTheme({ ...theme, systemDarkContrast: "soft" }, true),
      "#fefefe",
      "#000000",
    ],
    [resolveTheme(theme, true), "#001122", "#ffffff"],
  ] as const) {
    applyDocumentTheme(resolved);
    expect(style.getPropertyValue("--brand")).toBe(expectedColor);
    expect(style.getPropertyValue("--primary-foreground")).toBe(
      expectedForeground,
    );
  }
  applyDocumentTheme({ ...theme, mode: "dark", brandColors: { dark: "red" } });
  expect(style.getPropertyValue("--brand")).toBe("");
  expect(style.getPropertyValue("--primary-foreground")).toBe("");

  applyDocumentTheme(theme);
  applyDocumentTheme(defaultTheme);
  expect(style.getPropertyValue("--brand")).toBe("");
  expect(style.getPropertyValue("--primary-foreground")).toBe("");
});

it("accepts only six-digit hex brand colors", () => {
  expect(validBrandColor("#00aAbB")).toBe(true);
  for (const color of [
    "#abc",
    "#00aabbff",
    "#00gabb",
    "#00aabb\n",
    "red",
    123456,
    null,
    { toString: () => "#00aabb" },
  ]) {
    expect(validBrandColor(color)).toBe(false);
  }
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
