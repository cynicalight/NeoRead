import { expect, it } from "vitest";
import {
  startupAppearanceArgument,
  startupAppearanceFromArguments,
} from "./startup-appearance";

it("passes only bounded appearance values through the preload argument", () => {
  const argument = startupAppearanceArgument({
    appearance: "dark",
    pdfDarkContrast: "high",
    systemLightMode: "sepia",
    systemDarkContrast: "soft",
    mode: "dark",
    prompt: "private settings",
  });
  expect(startupAppearanceFromArguments(["electron", argument])).toEqual({
    appearance: "dark",
    pdfDarkContrast: "high",
    systemLightMode: "sepia",
    systemDarkContrast: "soft",
    mode: "dark",
  });
  expect(argument).not.toContain("private");
  expect(
    startupAppearanceFromArguments([
      startupAppearanceArgument({ appearance: "x".repeat(50000) }),
    ]),
  ).toEqual({});
});

it("leaves other windows unchanged and tolerates invalid arguments", () => {
  expect(startupAppearanceFromArguments([])).toBeUndefined();
  expect(
    startupAppearanceFromArguments(["--neoread-startup-appearance=%"]),
  ).toBeUndefined();
});
