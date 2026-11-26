import { afterEach, expect, it, vi } from "vitest";
import { api } from "./index";

afterEach(() => vi.unstubAllGlobals());
function stream(events: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          events.map((event) => JSON.stringify(event) + "\n").join(""),
          { headers: { "Content-Type": "application/x-ndjson" } },
        ),
    ),
  );
}
it("handles browser authorization phases and requires persisted completion", async () => {
  const authorize = {
    type: "auth_url",
    url: "https://claude.ai/oauth/authorize",
  };
  const progress = { type: "progress", phase: "exchanging" };
  stream([authorize, progress, { type: "complete" }]);
  const onEvent = vi.fn();
  await api.connectPiProvider("claude", new AbortController().signal, onEvent);
  expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
    authorize,
    progress,
  ]);
  stream([authorize, progress]);
  await expect(
    api.connectPiProvider("claude", new AbortController().signal, vi.fn()),
  ).rejects.toThrow("模型连接未确认");
});
it("does not treat the browser callback phase as success when exchange fails", async () => {
  stream([
    { type: "progress", phase: "exchanging" },
    { type: "error", error: "授权失败" },
  ]);
  await expect(
    api.connectPiProvider("claude", new AbortController().signal, vi.fn()),
  ).rejects.toThrow("授权失败");
});

it("retains the upstream status and full response body on a failed login", async () => {
  const body =
    '  {"error":{"message":"Country, region, or territory not supported","code":"unsupported_country_region_territory"}}\n' +
    "x".repeat(10_000);
  stream([
    { type: "progress", phase: "exchanging" },
    {
      type: "error",
      error: "授权服务拒绝了请求",
      upstreamStatus: 403,
      upstreamErrorBody: body,
    },
  ]);
  const error = await api
    .connectPiProvider("codex", new AbortController().signal, vi.fn())
    .catch((error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("授权服务拒绝了请求");
  expect(error.upstreamStatus).toBe(403);
  expect(error.upstreamErrorBody === body).toBe(true);
});

it("ignores malformed upstream detail fields without losing the login error", async () => {
  stream([
    {
      type: "error",
      error: "授权失败",
      upstreamStatus: "403",
      upstreamErrorBody: { html: "not a string" },
    },
  ]);
  const error = await api
    .connectPiProvider("codex", new AbortController().signal, vi.fn())
    .catch((error) => error);
  expect(error.message).toBe("授权失败");
  expect(error.upstreamStatus).toBeUndefined();
  expect(error.upstreamErrorBody).toBeUndefined();
});
