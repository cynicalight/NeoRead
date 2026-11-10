import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI } from "./index";
afterEach(() => {
  vi.unstubAllGlobals();
  configureAPI("");
});
it("posts continuation to the original run without resending question or history", async () => {
  const controller = new AbortController();
  configureAPI("test-local-token");
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "run", status: "running" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  expect(
    await api.continueChatRun("doc", "session", "run", controller.signal),
  ).toMatchObject({ id: "run", status: "running" });
  expect(fetch).toHaveBeenCalledOnce();
  const [path, init] = fetch.mock.calls[0];
  expect(path).toBe(
    "/api/documents/doc/chat-sessions/session/runs/run/continue",
  );
  expect(init.method).toBe("POST");
  expect(init.body).toBeUndefined();
  expect(init.headers.Authorization).toBe("Bearer test-local-token");
  controller.abort();
  expect(init.signal.aborted).toBe(true);
});
