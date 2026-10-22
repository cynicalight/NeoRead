import { expect, it, vi } from "vitest";
import { defaultTheme } from "@reader/core";
import { api } from "@reader/api";
import { saveReaderSettings } from "./reader-settings";

vi.mock("@reader/api", () => ({ api: { saveSettings: vi.fn() } }));

it("finishes older writes before the final close snapshot and recovers after a failed save", async () => {
  let finish!: () => void;
  vi.mocked(api.saveSettings).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(defaultTheme);
      }),
  );
  const first = saveReaderSettings(defaultTheme);
  await Promise.resolve();
  await Promise.resolve();
  const last = { ...defaultTheme, readerLayout: { navigationWidth: 23 } };
  const closing = saveReaderSettings(last);
  expect(api.saveSettings).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, closing]);
  expect(api.saveSettings).toHaveBeenLastCalledWith(last);
  vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("disk full"));
  await expect(saveReaderSettings(defaultTheme)).rejects.toThrow("disk full");
  await saveReaderSettings(last);
  expect(api.saveSettings).toHaveBeenLastCalledWith(last);
});
