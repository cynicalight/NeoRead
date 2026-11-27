// Only controlled values cross the worker diagnostics boundary. Never copy an
// exception message, provider payload, URL, tool name or user-defined model ID.
export class RunDiagnostics {
  phase = "starting";
  reasonCode = "agent_failed";
  stopReason = "none";
  providerStopReason = "none";
  providerEvent = "none";
  providerStatus = "none";
  providerErrorCode = "none";
  upstreamStatus = 0;
  networkCode = "none";
  partialOutput = false;
  requestCount = 0;

  request() {
    this.phase = "request";
    this.reasonCode = "agent_failed";
    this.stopReason =
      this.providerStopReason =
      this.providerEvent =
      this.providerStatus =
        "none";
    this.providerErrorCode = "none";
    this.upstreamStatus = 0;
    this.networkCode = "none";
    this.requestCount++;
  }

  response(status: number) {
    this.upstreamStatus = status;
    this.phase = status >= 400 ? "request" : "provider_stream";
    if (status >= 400) this.reasonCode = "http_error";
  }

  network(error: unknown) {
    this.reasonCode = "fetch_failed";
    // Node fetch wraps transport failures in TypeError.cause. Retain only
    // documented transport codes, never name/message/stack or the cause object.
    for (
      let depth = 0;
      depth < 4 && error && typeof error === "object";
      depth++
    ) {
      const value = error as { code?: unknown; cause?: unknown };
      if (
        typeof value.code === "string" &&
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ENOTFOUND",
          "EAI_AGAIN",
          "ETIMEDOUT",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
          "UND_ERR_SOCKET",
          "CERT_HAS_EXPIRED",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        ].includes(value.code)
      ) {
        this.networkCode = value.code;
        break;
      }
      error = value.cause;
    }
  }

  provider(value: unknown) {
    if (!value || typeof value !== "object") return;
    const event = value as {
      type?: unknown;
      error?: { code?: unknown; type?: unknown };
      response?: {
        error?: { code?: unknown; type?: unknown };
        status?: unknown;
        incomplete_details?: { reason?: unknown };
      };
    };
    this.providerEvent =
      typeof event.type === "string" &&
      [
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.output_item.done",
        "response.content_part.added",
        "response.content_part.done",
        "response.output_text.delta",
        "response.output_text.done",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.completed",
        "response.failed",
        "response.incomplete",
        "error",
        "message_start",
        "message_delta",
        "message_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
      ].includes(event.type)
        ? event.type
        : "unrecognized";
    if (event.response) {
      const status = event.response.status;
      this.providerStatus =
        typeof status === "string" &&
        [
          "completed",
          "incomplete",
          "in_progress",
          "failed",
          "cancelled",
          "queued",
        ].includes(status)
          ? status
          : "unrecognized";
    }
    if (event.type === "response.failed" || event.type === "error")
      this.reasonCode = "provider_error";
    const error = event.response?.error ?? event.error;
    if (error) {
      const code = error.code ?? error.type;
      this.providerErrorCode =
        typeof code === "string" &&
        [
          "server_error",
          "api_error",
          "overloaded_error",
          "rate_limit_error",
          "rate_limit_exceeded",
          "authentication_error",
          "permission_error",
          "invalid_request_error",
          "context_length_exceeded",
          "model_not_found",
          "insufficient_quota",
          "content_policy_violation",
        ].includes(code)
          ? code
          : "unrecognized";
    }

    if (event.type === "response.incomplete")
      this.reasonCode =
        event.response?.incomplete_details?.reason === "max_output_tokens"
          ? "output_limit"
          : "incomplete_response";
    if (
      (event.type === "response.completed" &&
        event.response?.status !== "completed") ||
      (event.type === "response.incomplete" &&
        event.response?.status !== "incomplete")
    )
      this.reasonCode = "invalid_completion_status";
  }

  assistant(
    stopReason: unknown,
    contextOverflow: boolean,
    rawStopReason?: string,
  ) {
    this.providerStopReason =
      rawStopReason === undefined
        ? "none"
        : [
              "end_turn",
              "max_tokens",
              "tool_use",
              "refusal",
              "pause_turn",
              "stop_sequence",
              "sensitive",
              "stop",
              "length",
              "tool_calls",
              "content_filter",
              "function_call",
              "STOP",
              "MAX_TOKENS",
              "SAFETY",
              "RECITATION",
              "BLOCKLIST",
              "PROHIBITED_CONTENT",
              "SPII",
              "IMAGE_SAFETY",
              "IMAGE_PROHIBITED_CONTENT",
              "IMAGE_RECITATION",
              "MALFORMED_FUNCTION_CALL",
              "UNEXPECTED_TOOL_CALL",
              "TOO_MANY_TOOL_CALLS",
            ].includes(rawStopReason)
          ? rawStopReason
          : "unrecognized";
    this.stopReason =
      typeof stopReason === "string" &&
      ["stop", "length", "toolUse", "error", "aborted"].includes(stopReason)
        ? stopReason
        : "unrecognized";
    if (
      [
        "refusal",
        "sensitive",
        "content_filter",
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
        "IMAGE_RECITATION",
      ].includes(this.providerStopReason)
    )
      this.reasonCode = "content_policy";
    else if (contextOverflow) this.reasonCode = "context_limit";
    else if (stopReason === "length") this.reasonCode = "output_limit";
    else if (stopReason === "aborted") this.reasonCode = "aborted";
    else if (stopReason === "error" && this.reasonCode === "agent_failed")
      this.reasonCode = "provider_error";
  }

  failure(
    reasonCode:
      "missing_assistant" | "empty_answer" | "checkpoint_failed" | "cancelled",
  ) {
    this.phase =
      reasonCode === "checkpoint_failed" ? "checkpoint" : "completion";
    this.reasonCode = reasonCode;
  }

  snapshot() {
    return {
      phase: this.phase,
      reasonCode: this.reasonCode,
      stopReason: this.stopReason,
      providerStopReason: this.providerStopReason,
      providerEvent: this.providerEvent,
      providerStatus: this.providerStatus,
      providerErrorCode: this.providerErrorCode,
      upstreamStatus: this.upstreamStatus,
      networkCode: this.networkCode,
      partialOutput: this.partialOutput,
      requestCount: this.requestCount,
    };
  }
}
