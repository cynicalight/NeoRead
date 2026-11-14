import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { loginConnection } from "./connections";
import { loginInteraction, type LoginEvent } from "./login-interaction";

const fetchNetwork = globalThis.fetch;
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(tokenStatus: number) {
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
      browser = fetchNetwork(callback, { signal: AbortSignal.timeout(3000) });
    }),
  );
  // Observe rejection immediately; assertions below still await the original.
  void operation.catch(() => {});
  await exchanging;
  return { authPath, controller, operation, events, browser, finishExchange };
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
