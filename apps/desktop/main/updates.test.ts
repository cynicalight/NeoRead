import { describe, expect, it, vi } from "vitest";
import {
  checkDue,
  DailyUpdateChecker,
  day,
  installerChecksum,
  newerRelease,
  retryDelay,
  selectRelease,
} from "./updates";
function release(version = "0.2.0") {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      `Reader-${version}-mac-arm64.dmg`,
      `Reader-${version}-win-x64.exe`,
      "SHA256SUMS.txt",
    ].map((name) => ({
      name,
      state: "uploaded",
      browser_download_url: `https://github.com/cynicalight/reader/releases/download/v${version}/${name}`,
    })),
  };
}
describe("release boundaries", () => {
  it("compares versions numerically and never downgrades", () => {
    expect(newerRelease("v0.10.0", "0.9.0")).toBe(true);
    expect(newerRelease("v0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(newerRelease("v0.2.0", "0.2.0")).toBe(false);
    expect(newerRelease("v0.2.0", "1.0.0")).toBe(false);
    expect(() => newerRelease("garbage", "0.1.0")).toThrow();
  });
  it("requires stable releases and official matching assets", () => {
    expect(selectRelease(release(), "0.1.0", "darwin", "arm64").status).toBe(
      "available",
    );
    expect(selectRelease(release(), "0.2.0", "darwin", "arm64").status).toBe(
      "current",
    );
    expect(() =>
      selectRelease(
        { ...release(), prerelease: true },
        "0.1.0",
        "darwin",
        "arm64",
      ),
    ).toThrow();
    expect(selectRelease(release(), "0.1.0", "darwin", "x64").status).toBe(
      "pending",
    );
    const bad = release();
    bad.assets[0].browser_download_url = "https://example.com/payload.dmg";
    expect(() => selectRelease(bad, "0.1.0", "darwin", "arm64")).toThrow();
  });
  it("selects the installer for the running platform", () => {
    const mac = selectRelease(release(), "0.1.0", "darwin", "arm64");
    const windows = selectRelease(release(), "0.1.0", "win32", "x64");
    expect(mac.status === "available" && mac.update.installer).toBe(
      "Reader-0.2.0-mac-arm64.dmg",
    );
    expect(windows.status === "available" && windows.update).toMatchObject({
      installer: "Reader-0.2.0-win-x64.exe",
      downloadURL:
        "https://github.com/cynicalight/reader/releases/download/v0.2.0/Reader-0.2.0-win-x64.exe",
    });
    expect(() => selectRelease(release(), "0.1.0", "win32", "arm64")).toThrow();
    expect(() => selectRelease(release(), "0.1.0", "linux", "x64")).toThrow();
  });
  it("offers the Mac update archive only when the release has one", () => {
    const withArchive = release();
    withArchive.assets.push({
      name: "Reader-0.2.0-mac-arm64.zip",
      state: "uploaded",
      browser_download_url:
        "https://github.com/cynicalight/reader/releases/download/v0.2.0/Reader-0.2.0-mac-arm64.zip",
    });
    const mac = selectRelease(withArchive, "0.1.0", "darwin", "arm64");
    expect(mac.status === "available" && mac.update.archive).toEqual({
      installer: "Reader-0.2.0-mac-arm64.zip",
      downloadURL:
        "https://github.com/cynicalight/reader/releases/download/v0.2.0/Reader-0.2.0-mac-arm64.zip",
    });
    const windows = selectRelease(withArchive, "0.1.0", "win32", "x64");
    expect(windows.status === "available" && windows.update.archive).toBe(
      undefined,
    );
    const old = selectRelease(release(), "0.1.0", "darwin", "arm64");
    expect(old.status === "available" && old.update.archive).toBe(undefined);
    withArchive.assets[3].browser_download_url = "https://example.com/x.zip";
    expect(() =>
      selectRelease(withArchive, "0.1.0", "darwin", "arm64"),
    ).toThrow();
  });
  it("selects Intel installers and archives without using Apple Silicon assets", () => {
    const intel = release();
    for (const ext of ["dmg", "zip"]) {
      const name = `Reader-0.2.0-mac-intel-x64.${ext}`;
      intel.assets.push({
        name,
        state: "uploaded",
        browser_download_url: `https://github.com/cynicalight/reader/releases/download/v0.2.0/${name}`,
      });
    }
    const result = selectRelease(intel, "0.1.0", "darwin", "x64");
    expect(result.status === "available" && result.update).toMatchObject({
      installer: "Reader-0.2.0-mac-intel-x64.dmg",
      archive: { installer: "Reader-0.2.0-mac-intel-x64.zip" },
    });
  });
  it("retries a release whose build assets are not ready", () => {
    expect(
      selectRelease({ ...release(), assets: [] }, "0.1.0", "darwin", "arm64")
        .status,
    ).toBe("pending");
  });
  it("requires exactly one matching SHA256", () => {
    const hash = "a".repeat(64);
    const line = `${hash}  Reader.dmg`;
    expect(installerChecksum(line, "Reader.dmg")).toBe(hash);
    expect(() => installerChecksum(line, "Other.dmg")).toThrow();
    expect(() => installerChecksum(`${line}\n${line}`, "Reader.dmg")).toThrow();
  });
});
describe("daily scheduling", () => {
  it("persists the daily interval across restarts and handles clock rollback", () => {
    expect(checkDue({}, day)).toBe(true);
    expect(checkDue({ lastChecked: day }, day + 1)).toBe(false);
    expect(checkDue({ lastChecked: day }, day * 2)).toBe(true);
    expect(checkDue({ lastAttempt: day }, day + retryDelay - 1)).toBe(false);
    expect(checkDue({ lastChecked: day * 3 }, day)).toBe(true);
  });
  it("coalesces simultaneous checks and persists successful completion", async () => {
    const state = {};
    const save = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(Response.json(release()));
    const checker = new DailyUpdateChecker({
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      state,
      save,
      fetch,
      now: () => day,
    });
    await Promise.all([checker.check(), checker.check()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ lastAttempt: day, lastChecked: day });
    expect(checker.isDue()).toBe(false);
  });
  it("does not mark failed or incomplete checks successful", async () => {
    const state = {};
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const checker = new DailyUpdateChecker({
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      state,
      save: async () => {},
      fetch,
      now: () => day,
    });
    await expect(checker.check()).rejects.toThrow("503");
    expect(state).toEqual({ lastAttempt: day });
    fetch.mockResolvedValue(Response.json({ ...release(), assets: [] }));
    expect((await checker.check()).status).toBe("pending");
    expect(state).toEqual({ lastAttempt: day });
  });
});

describe("update check failures", () => {
  it.each([
    [
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "86520" },
      "",
      /限流.*2 分钟/,
    ],
    [403, { "retry-after": "120" }, "", /限流.*2 分钟/],
    [
      403,
      {
        "retry-after": "invalid",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "86520",
      },
      "",
      /限流.*2 分钟/,
    ],
    [
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "86399" },
      "",
      /限流.*稍后/,
    ],
    [
      429,
      { "retry-after": "Thu, 02 Jan 1970 00:02:00 GMT" },
      "",
      /限流.*2 分钟/,
    ],
    [
      403,
      {},
      JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
      /限流/,
    ],
    [
      429,
      { "retry-after": "invalid", "x-ratelimit-reset": "Infinity" },
      "<html>private proxy details</html>",
      /限流.*稍后/,
    ],
    [403, { "x-ratelimit-remaining": "12" }, "Forbidden", /拒绝访问/],
    [503, {}, "<html>upstream error</html>", /服务暂时不可用/],
  ] as const)(
    "explains HTTP %s using response metadata",
    async (status, headers, body, expected) => {
      const state = {};
      const checker = new DailyUpdateChecker({
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        state,
        save: async () => {},
        now: () => day,
        fetch: async () => new Response(body, { status, headers }),
      });
      const error = await checker.check().catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(expected);
      expect((error as Error).message).toContain(String(status));
      expect((error as Error).message).not.toMatch(
        /<html>|Infinity|NaN|private proxy/,
      );
      expect(state).toEqual({ lastAttempt: day });
    },
  );
});
