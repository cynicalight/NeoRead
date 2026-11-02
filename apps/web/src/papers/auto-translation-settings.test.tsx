// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultTheme } from "@neoread/core";
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
