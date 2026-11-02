// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { defaultTheme } from "@neoread/core";
import { useReaderStore } from "./store";
import {
  installMotionPreference,
  reducedMotion,
  useReducedMotion,
} from "./motion";
import { animatePDFScroll } from "./readers/pdf-scroll";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  useReaderStore.setState({ theme: defaultTheme });
  vi.unstubAllGlobals();
});

it("enables motion for old settings even when the system requests reduced motion", () => {
  const query = vi.fn(() => ({ matches: true }));
  vi.stubGlobal("matchMedia", query);
  const { reducedMotion: _old, ...legacy } = defaultTheme;
  useReaderStore.setState({ theme: legacy });
  cleanups.push(installMotionPreference(document));
  expect(reducedMotion()).toBe(false);
  expect(document.documentElement.dataset.reducedMotion).toBe("false");
  expect(query).not.toHaveBeenCalled();
});

it("updates React, the shell and EPUB documents together and unsubscribes on disposal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => {
      throw new Error("must not query the system");
    }),
  );
  useReaderStore.setState({ theme: defaultTheme });
  const epub = document.implementation.createHTMLDocument("EPUB");
  const removeShell = installMotionPreference(document);
  const removeEPUB = installMotionPreference(epub);
  cleanups.push(removeShell, removeEPUB);
  const host = document.createElement("div");
  const root = createRoot(host);
  function Status() {
    return <span>{String(useReducedMotion())}</span>;
  }
  try {
    await act(async () => root.render(<Status />));
    expect(host.textContent).toBe("false");
    await act(async () =>
      useReaderStore.getState().setTheme({ reducedMotion: true }),
    );
    expect(host.textContent).toBe("true");
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    expect(epub.documentElement.dataset.reducedMotion).toBe("true");
    // Reader operations use the preference immediately, without waiting for a render.
    const page = document.createElement("div");
    await animatePDFScroll(
      page,
      20,
      40,
      () => false,
      () => {},
    );
    expect(page.scrollTop).toBe(40);
    removeEPUB();
    await act(async () =>
      useReaderStore.getState().setTheme({ reducedMotion: false }),
    );
    expect(host.textContent).toBe("false");
    expect(document.documentElement.dataset.reducedMotion).toBe("false");
    expect(epub.documentElement.hasAttribute("data-reduced-motion")).toBe(
      false,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
