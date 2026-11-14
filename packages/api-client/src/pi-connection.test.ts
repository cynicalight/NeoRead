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
