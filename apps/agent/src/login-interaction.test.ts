import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { loginConnection } from "./connections";
import { loginInteraction, type LoginEvent } from "./login-interaction";

const fetchNetwork = globalThis.fetch;
const directories: string[] = [];
const subscribers: ((event: unknown) => void)[] = [];
const callbackChannel = channel("neoread.pi.oauth.callback");
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const subscriber of subscribers.splice(0))
    callbackChannel.unsubscribe(subscriber);
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(tokenStatus: number, rejectCallbacks = false) {
  const dir = await mkdtemp(join(tmpdir(), "neoread-login-"));
  directories.push(dir);
  const authPath = join(dir, "auth.json");
  const controller = new AbortController();
  let exchangeStarted!: () => void;
  let finishExchange!: () => void;
  const exchanging = new Promise<void>((resolve) => {
    exchangeStarted = resolve;
  });
  const exchangeReady = new Promise<void>((resolve) => {
    finishExchange = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin !== "https://platform.claude.com" ||
        url.pathname !== "/v1/oauth/token"
      )
        throw new Error("Unexpected external request");
      exchangeStarted();
      await exchangeReady;
      return new Response(
        JSON.stringify(
          tokenStatus === 200
            ? {
                access_token: "fixture-access",
                refresh_token: "fixture-refresh",
                expires_in: 3600,
              }
            : { error: "invalid_grant" },
        ),
        { status: tokenStatus },
      );
    }),
  );
  const callbackEvents: { stage: string; reasonCode?: string }[] = [];
  const subscriber = (event: unknown) =>
    callbackEvents.push(event as (typeof callbackEvents)[number]);
  subscribers.push(subscriber);
  callbackChannel.subscribe(subscriber);
  const events: LoginEvent[] = [];
  let browser!: Promise<Response>;
  const operation = loginConnection(
    { provider: "anthropic", authPath },
    "fixture-device",
    loginInteraction(controller.signal, (event) => {
      events.push(event);
      if (event.type !== "auth_url") return;
      const authorization = new URL(event.url);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      browser = (async () => {
        if (rejectCallbacks) {
          const invalidState = new URL(callback);
          invalidState.searchParams.set("state", "wrong-private-state");
          expect((await fetchNetwork(invalidState)).status).toBe(400);
          const missingCode = new URL(callback);
          missingCode.searchParams.delete("code");
          expect((await fetchNetwork(missingCode)).status).toBe(400);
        }
        return fetchNetwork(callback, { signal: AbortSignal.timeout(3000) });
      })();
    }),
  );
  // Observe rejection immediately; assertions below still await the original.
  void operation.catch(() => {});
  await exchanging;
  return {
    authPath,
    controller,
    operation,
    events,
    callbackEvents,
    browser,
    finishExchange,
  };
}

test("Claude SDK callback completes and saves credentials without pasted input", async () => {
  const login = await fixture(200);
  try {
    // The SDK browser page precedes token exchange, not connection completion.
    expect((await login.browser).status).toBe(200);
    expect(readStoredCredential("anthropic", login.authPath)).toBeUndefined();
    expect(login.events).toContainEqual({
      type: "progress",
      phase: "exchanging",
    });
    login.finishExchange();
    await login.operation;
    expect(login.callbackEvents.map((event) => event.stage)).toEqual([
      "listen_start",
      "listening",
      "received",
      "accepted",
      "completed",
      "close_requested",
    ]);
    expect(readStoredCredential("anthropic", login.authPath)?.type).toBe(
      "oauth",
    );
  } finally {
    login.finishExchange();
    login.controller.abort();
  }
});

test("a browser success followed by rejected token exchange never saves a connection", async () => {
  const login = await fixture(400);
  try {
    expect((await login.browser).status).toBe(200);
    login.finishExchange();
    await expect(login.operation).rejects.toThrow("status=400");
    expect(readStoredCredential("anthropic", login.authPath)).toBeUndefined();
  } finally {
    login.finishExchange();
    login.controller.abort();
  }
});

test("the unused SDK manual prompt stays pending until cancellation", async () => {
  const controller = new AbortController();
  const send = vi.fn();
  const interaction = loginInteraction(controller.signal, send);
  const manual = interaction.prompt({
    type: "manual_code",
    message: "fixture",
  });
  let settled = false;
  void manual.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(send).not.toHaveBeenCalled();
  controller.abort(new Error("cancelled"));
  await expect(manual).rejects.toThrow("cancelled");
});

test("SDK reports rejected callbacks and keeps waiting for a valid retry", async () => {
  const login = await fixture(200, true);
  try {
    expect((await login.browser).status).toBe(200);
    login.finishExchange();
    await login.operation;
    expect(
      login.callbackEvents.filter((event) => event.stage === "rejected"),
    ).toMatchObject([
      { reasonCode: "state_mismatch" },
      { reasonCode: "missing_code" },
    ]);
    expect(
      login.callbackEvents.filter((event) => event.stage === "received"),
    ).toHaveLength(3);
    expect(JSON.stringify(login.callbackEvents)).not.toMatch(
      /wrong-private-state|fixture-code/,
    );
  } finally {
    login.finishExchange();
    login.controller.abort();
  }
});

// Exercise the shared helper shipped by the pinned SDK, including failures its
// provider login catches internally. Resolve from the real package entrypoint.
test("SDK reports an occupied callback port even when the provider can swallow that failure", async () => {
  const { createServer } = await import("node:http");
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const { startOAuthCallbackServer } = await import(
    /* @vite-ignore */ new URL("auth/oauth/callback-server.js", entry).href
  );
  const occupied = createServer();
  await new Promise<void>((resolve) =>
    occupied.listen(0, "127.0.0.1", resolve),
  );
  const port = (occupied.address() as { port: number }).port;
  const events: { stage: string; error?: { code?: string } }[] = [];
  const subscriber = (event: unknown) =>
    events.push(event as (typeof events)[number]);
  callbackChannel.subscribe(subscriber);
  try {
    await expect(
      startOAuthCallbackServer({
        providerName: "OpenAI",
        host: "127.0.0.1",
        port,
        path: "/auth/callback",
        complete: async (code: string) => code,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(events.map((event) => event.stage)).toEqual([
      "listen_start",
      "listen_failed",
    ]);
    expect(events.at(-1)?.error?.code).toBe("EADDRINUSE");
  } finally {
    callbackChannel.unsubscribe(subscriber);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test.each(["denied", "cancelled", "timeout"])(
  "SDK records callback terminal reason %s",
  async (mode) => {
    const entry = import.meta.resolve("@earendil-works/pi-ai");
    const { startOAuthCallbackServer } = await import(
      /* @vite-ignore */ new URL("auth/oauth/callback-server.js", entry).href
    );
    const events: { stage: string; reasonCode?: string }[] = [];
    const subscriber = (event: unknown) =>
      events.push(event as (typeof events)[number]);
    callbackChannel.subscribe(subscriber);
    const controller = new AbortController();
    const callback = await startOAuthCallbackServer({
      providerName: "OpenAI",
      host: "127.0.0.1",
      port: 0,
      path: "/auth/callback",
      state: "private-state",
      signal: controller.signal,
      timeoutMs: mode === "timeout" ? 20 : undefined,
      complete: async (code: string) => code,
    });
    const waiting = callback.wait();
    void waiting.catch(() => {});
    try {
      if (mode === "denied") {
        const target = new URL(callback.redirectUri);
        target.searchParams.set("state", "private-state");
        target.searchParams.set("error", "access_denied");
        target.searchParams.set(
          "error_description",
          "private-error-description",
        );
        expect((await fetchNetwork(target)).status).toBe(400);
      } else if (mode === "cancelled") controller.abort();
      await expect(waiting).rejects.toThrow();
      expect(events).toContainEqual(
        expect.objectContaining({
          reasonCode:
            mode === "denied"
              ? "authorization_denied"
              : mode === "cancelled"
                ? "login_cancelled"
                : "callback_timeout",
        }),
      );
      expect(JSON.stringify(events)).not.toMatch(
        /private-state|private-error-description/,
      );
    } finally {
      callback.close();
      callbackChannel.unsubscribe(subscriber);
    }
  },
);
