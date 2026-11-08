import { afterEach, expect, it, vi } from "vitest";
import { api, RequestError } from "./index";
afterEach(() => vi.unstubAllGlobals());
it("preserves HTTP status and error classification for bounded retries", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "unavailable", code: "network" }),
          { status: 502 },
        ),
    ),
  );
  await expect(api.agentModels("codex")).rejects.toMatchObject({
    status: 502,
    code: "network",
  });
  await expect(api.aiConfig()).rejects.toBeInstanceOf(RequestError);
});
it("passes cancellation signals to config reads", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await api.aiConfig(signal);
  expect(fetch.mock.calls).toHaveLength(1);
  for (const call of vi.mocked(globalThis.fetch).mock.calls)
    expect(call[1]?.signal).toBe(signal);
});
