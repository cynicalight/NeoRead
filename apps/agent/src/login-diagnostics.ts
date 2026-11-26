import { channel } from "node:diagnostics_channel";

// This channel is supplied by the diagnostic-only patch of the pinned Pi SDK.
const callbackChannel = channel("neoread.pi.oauth.callback");
const systemCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ABORT_ERR",
]);
const errorTypes = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "TimeoutError",
  "SystemError",
]);

export type LoginFailure = {
  reasonCode: string;
  errorType: string;
  systemCode?: string;
};
export type LoginDiagnostic = LoginFailure & {
  kind: "callback" | "request" | "sdk";
  stage: string;
  callbackPort?: number;
  addressFamily?: string;
  operation?: string;
  upstreamStatus?: number;
  upstreamErrorBody?: string;
  durationMs?: number;
};
export type LoginDiagnosticEvent = {
  type: "diagnostic";
  diagnostic: LoginDiagnostic;
};

// Inspect nested network causes before SDK wrappers discard them. Never copy
// arbitrary exception messages into the structured classification fields.
export function loginFailure(error: unknown): LoginFailure {
  const queue = [error];
  const seen = new Set<unknown>();
  let errorType = "unrecognized";
  let systemCode: string | undefined;
  let reasonCode = "sdk_error";
  while (queue.length && seen.size < 16) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const e = item as {
      name?: string;
      code?: string;
      message?: string;
      cause?: unknown;
      errors?: unknown[];
    };
    if (errorType === "unrecognized" && e.name && errorTypes.has(e.name))
      errorType = e.name;
    if (!systemCode && e.code && systemCodes.has(e.code)) systemCode = e.code;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors);
    const message = typeof e.message === "string" ? e.message : "";
    if (/^(?:OAuth )?[Ss]tate mismatch$/.test(message))
      reasonCode = "state_mismatch";
    else if (message === "Missing authorization code")
      reasonCode = "missing_code";
    else if (/^Login cancelled$/.test(message) || e.name === "AbortError")
      reasonCode = "login_cancelled";
    else if (e.name === "TimeoutError") reasonCode = "network_timeout";
    else if (
      e.name === "SyntaxError" ||
      /^Token exchange returned invalid JSON\./.test(message)
    )
      reasonCode = "invalid_json";
    else if (
      /^OpenAI Codex token exchange response missing fields:/.test(message)
    )
      reasonCode = "invalid_token_response";
    else if (message === "Failed to extract accountId from token")
      reasonCode = "missing_account_id";
    else if (
      /^(?:OpenAI Codex token exchange failed \(|Token exchange request failed\.)/.test(
        message,
      )
    )
      reasonCode = "token_exchange_failed";
  }
  if (systemCode) {
    if (["ENOTFOUND", "EAI_AGAIN"].includes(systemCode))
      reasonCode = "dns_failed";
    else if (
      [
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(systemCode)
    )
      reasonCode = "network_timeout";
    else if (
      systemCode.includes("CERT") ||
      systemCode.startsWith("ERR_TLS") ||
      systemCode.startsWith("ERR_SSL") ||
      systemCode.startsWith("DEPTH_") ||
      systemCode.startsWith("SELF_SIGNED") ||
      systemCode.startsWith("UNABLE_")
    )
      reasonCode = "tls_failed";
    else if (systemCode === "ECONNREFUSED") reasonCode = "connection_refused";
    else if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(systemCode))
      reasonCode = "connection_reset";
    else if (["ENETUNREACH", "EHOSTUNREACH"].includes(systemCode))
      reasonCode = "network_unreachable";
    else if (systemCode === "EADDRINUSE") reasonCode = "address_in_use";
    else if (systemCode === "EADDRNOTAVAIL") reasonCode = "address_unavailable";
    else if (["ABORT_ERR", "UND_ERR_ABORTED"].includes(systemCode))
      reasonCode = "login_cancelled";
    else reasonCode = "system_error";
  }
  return { reasonCode, errorType, ...(systemCode ? { systemCode } : {}) };
}

export function loginDiagnostics(send: (event: LoginDiagnosticEvent) => void) {
  const report = (diagnostic: LoginDiagnostic) => {
    // Diagnostic failures must not change the authorization outcome.
    try {
      send({ type: "diagnostic", diagnostic });
    } catch {
      /* No logging recursion. */
    }
  };
  const subscriber = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const event = value as {
      stage: string;
      reasonCode?: string;
      error?: unknown;
      callbackPort?: number;
      addressFamily?: string;
    };
    const failure = event.error
      ? loginFailure(event.error)
      : { reasonCode: "", errorType: "" };
    report({
      ...failure,
      kind: "callback",
      stage: event.stage,
      reasonCode:
        event.error && failure.reasonCode !== "sdk_error"
          ? failure.reasonCode
          : event.reasonCode || "",
      callbackPort: event.callbackPort,
      addressFamily: event.addressFamily,
    });
  };
  callbackChannel.subscribe(subscriber);
  let lastNetworkFailure: LoginFailure | undefined;
  return {
    async fetch(
      fetch: typeof globalThis.fetch,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      lastNetworkFailure = undefined;
      const started = performance.now();
      const url = new URL(input instanceof Request ? input.url : String(input));
      const operation = /\/(?:oauth\/)?token$/.test(url.pathname)
        ? "token_exchange"
        : "authorization_request";
      report({
        kind: "request",
        stage: "start",
        operation,
        reasonCode: "",
        errorType: "",
      });
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        lastNetworkFailure = loginFailure(error);
        report({
          ...lastNetworkFailure,
          kind: "request",
          stage: "failed",
          operation,
          durationMs: Math.round(performance.now() - started),
        });
        throw error;
      }
      // Record headers immediately: a stalled/failed body must not hide the
      // HTTP rejection when the login deadline terminates this worker.
      report({
        kind: "request",
        stage: "response",
        operation,
        reasonCode: response.ok ? "" : "http_rejected",
        errorType: "",
        upstreamStatus: response.status,
        durationMs: Math.round(performance.now() - started),
      });
      // Explicitly preserve the entire upstream failure body verbatim, as requested.
      // Never read or record a successful token response.
      if (response.status >= 400) {
        try {
          const upstreamErrorBody = await response.clone().text();
          report({
            kind: "request",
            stage: "error_body",
            operation,
            reasonCode: "http_rejected",
            errorType: "",
            upstreamStatus: response.status,
            upstreamErrorBody,
            durationMs: Math.round(performance.now() - started),
          });
        } catch (error) {
          lastNetworkFailure = loginFailure(error);
          report({
            ...lastNetworkFailure,
            kind: "request",
            stage: "body_failed",
            operation,
            upstreamStatus: response.status,
            durationMs: Math.round(performance.now() - started),
          });
        }
      }
      return response;
    },
    failure(error: unknown) {
      const failure = lastNetworkFailure || loginFailure(error);
      report({ ...failure, kind: "sdk", stage: "failed" });
      return failure;
    },
    close() {
      callbackChannel.unsubscribe(subscriber);
    },
  };
}
