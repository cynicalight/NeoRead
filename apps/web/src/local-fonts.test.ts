import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fontPreferences: vi.fn(),
  saveFontPreferences: vi.fn(async (value: unknown) => value),
}));
vi.mock("@neoread/api", () => ({ api }));

beforeEach(() => {
  vi.resetModules();
  api.fontPreferences.mockReset();
  api.saveFontPreferences.mockClear();
  vi.unstubAllGlobals();
});

it("shows the list saved on an earlier launch without querying fonts", async () => {
  api.fontPreferences.mockResolvedValue({ families: ["Songti SC", 3, ""] });
  const query = vi.fn();
  vi.stubGlobal("window", { queryLocalFonts: query });
  const fonts = await import("./local-fonts");
  expect(await fonts.savedLocalFontFamilies()).toEqual(["Songti SC"]);
  expect(fonts.loadedLocalFontFamilies()).toEqual(["Songti SC"]);
  expect(query).not.toHaveBeenCalled();
});

it("saves a fresh read for later launches", async () => {
  api.fontPreferences.mockResolvedValue({});
  vi.stubGlobal("window", {
    queryLocalFonts: async () => [
      { family: "PingFang SC" },
      { family: "Kaiti SC" },
      { family: "PingFang SC" },
    ],
  });
  const fonts = await import("./local-fonts");
  expect(await fonts.localFontFamilies()).toEqual(["Kaiti SC", "PingFang SC"]);
  expect(api.saveFontPreferences).toHaveBeenCalledWith({
    families: ["Kaiti SC", "PingFang SC"],
  });
  expect(await fonts.savedLocalFontFamilies()).toEqual([
    "Kaiti SC",
    "PingFang SC",
  ]);
  expect(api.fontPreferences).not.toHaveBeenCalled();
});

it("keeps working when the saved list cannot be read", async () => {
  api.fontPreferences.mockRejectedValue(new Error("offline"));
  vi.stubGlobal("window", {});
  const fonts = await import("./local-fonts");
  expect(await fonts.savedLocalFontFamilies()).toEqual([]);
  await expect(fonts.localFontFamilies()).rejects.toThrow("无法读取本机字体");
});
