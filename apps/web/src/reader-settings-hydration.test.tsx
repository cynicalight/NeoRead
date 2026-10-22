// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { defaultTheme, type ReaderTheme } from "@reader/core";
import { useSaveReaderSettings } from "./reader-settings";

vi.mock("@reader/api", () => ({ api: { saveSettings: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

it("saves restored settings once hydration finishes even without another theme change", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  function Settings({ theme, ready }: { theme: ReaderTheme; ready: boolean }) {
    useSaveReaderSettings(theme, ready);
    return null;
  }
  try {
    await act(async () =>
      root.render(<Settings theme={defaultTheme} ready={false} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(api.saveSettings).not.toHaveBeenCalled();
    const restored = { ...defaultTheme, documentZooms: { paper: 1.16 } };
    await act(async () =>
      root.render(<Settings theme={restored} ready={false} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(api.saveSettings).not.toHaveBeenCalled();
    await act(async () => root.render(<Settings theme={restored} ready />));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith(restored);
    const updated = { ...restored, zoom: 2 };
    await act(async () => root.render(<Settings theme={updated} ready />));
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
