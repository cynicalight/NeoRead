import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { connectionQuota } from "./quota";
import type { PiConnection } from "./connections";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function connection(
  provider: PiConnection["provider"],
  access = "fixture-secret",
  expired = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "neoread-quota-"));
  directories.push(dir);
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      [provider]: {
        type: "oauth",
        access,
        refresh: "fixture-refresh-secret",
        expires: expired ? 0 : Date.now() + 3600000,
        ...(provider === "openai"
          ? { clientId: "fixture-issued-client", accountId: "stale-account" }
          : {}),
      },
    }),
  );
  return { provider, authPath };
}
const signal = () => new AbortController().signal;
function response(data: unknown) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(data),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

test("Codex never substitutes account-wide quota for this app's allowance", async () => {
  const selected = await connection("openai", "fixture-app-token", true);
  const fetch = response({
    rate_limit: {
      secondary_window: { limit_window_seconds: 604800, used_percent: 10 },
    },
  });
  const quota = await connectionQuota(selected, signal());
  expect(quota.remaining).toBeUndefined();
  expect(quota.error).toContain("本应用");
  expect(fetch).not.toHaveBeenCalled();
});

test.each([0, 100])(
  "Claude reads seven_day at %s percent used and normalizes ISO reset",
  async (used) => {
    const fetch = response({
      five_hour: { utilization: 99 },
      seven_day: { utilization: used, resets_at: "2026-11-20T08:00:00+08:00" },
    });
    expect(
      await connectionQuota(await connection("anthropic"), signal()),
    ).toEqual({ remaining: 100 - used, resetsAt: "2026-11-20T00:00:00.000Z" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
      "oauth-2025-04-20",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-secret",
    );
  },
);

test.each([undefined, null, "20", -1, 101, Number.NaN, Infinity])(
  "rejects missing or invalid utilization %s",
  async (used) => {
    response({ seven_day: { utilization: used } });
    const quota = await connectionQuota(
      await connection("anthropic"),
      signal(),
    );
    expect(quota.error).toBeTruthy();
    expect(quota.remaining).toBeUndefined();
  },
);

test.each(["invalid", null, -1, 1e99])(
  "invalid resets are omitted, not invented: %s",
  async (reset) => {
    response({ seven_day: { utilization: 10, resets_at: reset } });
    expect(
      await connectionQuota(await connection("anthropic"), signal()),
    ).toEqual({ remaining: 90 });
  },
);

test.each([401, 403, 429, 500])(
  "HTTP %s rejects without propagating upstream secrets",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("upstream-secret fixture-secret", { status }),
      ),
    );
    await expect(
      connectionQuota(await connection("anthropic"), signal()),
    ).rejects.toThrow("无法读取当前连接的周额度");
  },
);

test("invalid JSON and SDK refresh failures are sanitized", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("upstream-secret invalid-json")),
  );
  await expect(
    connectionQuota(await connection("anthropic"), signal()),
  ).rejects.toThrow("无法读取当前连接的周额度");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("upstream-secret", { status: 401 })),
  );
  await expect(
    connectionQuota(
      await connection("anthropic", "expired-secret", true),
      signal(),
    ),
  ).rejects.toThrow("无法读取当前连接的周额度");
});

test("redirect errors are sanitized and the request is never permitted to follow", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("redirect to fixture-secret");
    }),
  );
  await expect(
    connectionQuota(await connection("anthropic"), signal()),
  ).rejects.toThrow("无法读取当前连接的周额度");
});

test("cancellation propagates through the request signal without exposing abort reasons", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort("fixture-secret");
      init?.signal?.throwIfAborted();
    }),
  );
  await expect(
    connectionQuota(await connection("anthropic"), controller.signal),
  ).rejects.toThrow("额度查询已取消");
});

test("missing connection credentials never fall back to ambient API keys", async () => {
  const selected = await connection("anthropic");
  await writeFile(selected.authPath, "{}");
  vi.stubEnv("ANTHROPIC_API_KEY", "ambient-secret");
  const fetch = response({ seven_day: { utilization: 0 } });
  try {
    await expect(connectionQuota(selected, signal())).rejects.toThrow(
      "无法读取当前连接的周额度",
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Claude without seven_day returns unavailable instead of the short-window value", async () => {
  response({ five_hour: { utilization: 100 } });
  expect(
    await connectionQuota(await connection("anthropic"), signal()),
  ).toEqual({ error: "当前连接未提供周额度窗口" });
});

test("already cancelled operations never resolve credentials or request usage", async () => {
  const selected = await connection("anthropic");
  const fetch = response({ seven_day: { utilization: 0 } });
  const controller = new AbortController();
  controller.abort("fixture-secret");
  await expect(connectionQuota(selected, controller.signal)).rejects.toThrow(
    "额度查询已取消",
  );
  expect(fetch).not.toHaveBeenCalled();
});
