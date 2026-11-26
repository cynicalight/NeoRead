import { channel } from "node:diagnostics_channel";
import { expect, test, vi } from "vitest";
import {
  loginDiagnostics,
  loginFailure,
  type LoginDiagnosticEvent,
} from "./login-diagnostics";

test("keeps the full failed upstream body verbatim without consuming the SDK response", async () => {
  const events: LoginDiagnosticEvent[] = [];
  const diagnostics = loginDiagnostics((event) => events.push(event));
  const body = JSON.stringify({
    error: {
      message: "Denied: https://auth.example/path?code=private",
      code: "access_denied",
    },
    access_token: "fixture-token",
    padding: "x".repeat(100_000),
  });
  try {
    const response = await diagnostics.fetch(
      vi.fn().mockResolvedValue(new Response(body, { status: 403 })),
      "https://auth.openai.com/oauth/token",
    );
    expect(await response.text()).toBe(body);
    expect(events.at(-1)?.diagnostic).toMatchObject({
      kind: "request",
      stage: "error_body",
      upstreamStatus: 403,
      operation: "token_exchange",
    });
    expect(events.at(-1)?.diagnostic.upstreamErrorBody === body).toBe(true);
  } finally {
    diagnostics.close();
  }
});

test("does not collect a successful token response", async () => {
  const send = vi.fn();
  const diagnostics = loginDiagnostics(send);
  try {
    const response = await diagnostics.fetch(
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"access_token":"private-success-token"}'),
        ),
      "https://auth.openai.com/oauth/token",
    );
    expect(await response.json()).toEqual({
      access_token: "private-success-token",
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain(
      "private-success-token",
    );
  } finally {
    diagnostics.close();
  }
});

test.each([
  ["ENOTFOUND", "dns_failed"],
  ["ECONNREFUSED", "connection_refused"],
  ["ECONNRESET", "connection_reset"],
  ["UND_ERR_CONNECT_TIMEOUT", "network_timeout"],
  ["CERT_HAS_EXPIRED", "tls_failed"],
  ["EADDRINUSE", "address_in_use"],
])(
  "preserves nested network cause %s through SDK error wrapping",
  async (code, reasonCode) => {
    const send = vi.fn();
    const diagnostics = loginDiagnostics(send);
    const network = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("fixture-private-url"), { code }),
      ]),
    });
    try {
      await expect(
        diagnostics.fetch(
          vi.fn().mockRejectedValue(network),
          "https://auth.openai.com/oauth/token",
        ),
      ).rejects.toBe(network);
      expect(
        diagnostics.failure(new Error("SDK discarded the original cause")),
      ).toEqual({ reasonCode, systemCode: code, errorType: "TypeError" });
      expect(JSON.stringify(send.mock.calls)).not.toContain(
        "fixture-private-url",
      );
    } finally {
      diagnostics.close();
    }
  },
);

test("classifies SDK validation failures and removes its channel subscriber on completion", () => {
  expect(
    loginFailure(
      new Error(
        'OpenAI Codex token exchange response missing fields: {"private":"value"}',
      ),
    ),
  ).toMatchObject({ reasonCode: "invalid_token_response" });
  const send = vi.fn();
  const diagnostics = loginDiagnostics(send);
  const callback = channel("neoread.pi.oauth.callback");
  callback.publish({
    stage: "listen_failed",
    error: Object.assign(new Error("private"), { code: "EADDRINUSE" }),
    callbackPort: 1455,
    addressFamily: "ipv4",
  });
  expect(send).toHaveBeenCalledWith({
    type: "diagnostic",
    diagnostic: {
      kind: "callback",
      stage: "listen_failed",
      reasonCode: "address_in_use",
      systemCode: "EADDRINUSE",
      errorType: "Error",
      callbackPort: 1455,
      addressFamily: "ipv4",
    },
  });
  diagnostics.close();
  callback.publish({ stage: "closed" });
  expect(send).toHaveBeenCalledTimes(1);
});

test("records response-body transport failures without inventing a body", async () => {
  const events: LoginDiagnosticEvent[] = [];
  const diagnostics = loginDiagnostics((event) => events.push(event));
  const error = Object.assign(new Error("private-body-error"), {
    code: "ECONNRESET",
  });
  try {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
      { status: 403 },
    );
    await diagnostics.fetch(
      vi.fn().mockResolvedValue(response),
      "https://auth.openai.com/oauth/token",
    );
    expect(events.at(-1)?.diagnostic).toMatchObject({
      stage: "body_failed",
      systemCode: "ECONNRESET",
      upstreamStatus: 403,
    });
    expect(
      events.find((event) => event.diagnostic.stage === "response")?.diagnostic
        .upstreamErrorBody,
    ).toBeUndefined();
    expect(diagnostics.failure(new Error("SDK wrapper"))).toMatchObject({
      reasonCode: "connection_reset",
      systemCode: "ECONNRESET",
    });
  } finally {
    diagnostics.close();
  }
});

test("a later successful request clears an earlier transport failure", async () => {
  const diagnostics = loginDiagnostics(() => {});
  try {
    await expect(
      diagnostics.fetch(
        vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("failed"), { code: "ECONNRESET" }),
          ),
        "https://auth.openai.com/oauth/token",
      ),
    ).rejects.toThrow();
    await diagnostics.fetch(
      vi.fn().mockResolvedValue(new Response("{}")),
      "https://auth.openai.com/oauth/token",
    );
    expect(diagnostics.failure(new SyntaxError("invalid JSON"))).toEqual({
      errorType: "SyntaxError",
      reasonCode: "invalid_json",
    });
  } finally {
    diagnostics.close();
  }
});
