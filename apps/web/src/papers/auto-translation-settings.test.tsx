// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultTheme } from "@reader/core";
import { AutoTranslationSettings } from "./AutoTranslationSettings";

it("updates the highlighted threshold by tens with keyboard input and describes zero", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [theme, setTheme] = useState(defaultTheme);
    return (
      <AutoTranslationSettings
        theme={theme}
        setTheme={(patch) =>
          setTheme((previous) => ({ ...previous, ...patch }))
        }
      />
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.value).toBe("50");
    const thumb = host.querySelector<HTMLElement>(
      '[data-slot="slider-thumb"]',
    )!;
    expect(thumb.style.visibility).not.toBe("hidden");
    expect(parseFloat(thumb.style.insetInlineStart)).toBeCloseTo(100 / 3);
    expect(thumb.style.clipPath).toBe("");
    const indicator = host.querySelector<HTMLElement>(
      '[data-slot="slider-range"]',
    )!;
    expect(parseFloat(indicator.style.width)).toBeCloseTo(100 / 3);
    await act(async () => {
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(host.querySelector("p span")?.textContent).toBe("60");
    expect(slider.getAttribute("aria-valuetext")).toBe("超过 60 页则手动翻译");
    await act(async () => {
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(host.querySelector("p")?.textContent).toBe("所有论文全部手动翻译");
    expect(slider.value).toBe("0");
    await act(async () => {
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(host.querySelector("p span")?.textContent).toBe("150");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each([0, 50, 80, 100, 150])(
  "positions the thumb at saved value %s on first mount and reopening before layout measurement",
  async (limit) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      for (let opening = 0; opening < 2; opening++) {
        await act(async () =>
          root.render(
            <AutoTranslationSettings
              theme={{ ...defaultTheme, autoTranslateMaxPages: limit }}
              setTheme={() => {}}
            />,
          ),
        );
        const thumb = host.querySelector<HTMLElement>(
          '[data-slot="slider-thumb"]',
        )!;
        expect(thumb.style.visibility).not.toBe("hidden");
        expect(parseFloat(thumb.style.insetInlineStart)).toBeCloseTo(
          (limit / 150) * 100,
        );
        const indicator = host.querySelector<HTMLElement>(
          '[data-slot="slider-range"]',
        )!;
        expect(indicator.style.visibility).not.toBe("hidden");
        expect(parseFloat(indicator.style.width)).toBeCloseTo(
          (limit / 150) * 100,
        );
        await act(async () => root.render(null));
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);
