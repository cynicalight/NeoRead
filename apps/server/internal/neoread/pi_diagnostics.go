package neoread

import (
	"context"
	"log/slog"
)

// Worker strings are untrusted even when produced by the bundled worker. Keep
// the log schema closed; raw errors, payloads and user-defined IDs stay out.
type piFailureDiagnostics struct {
	ProviderErrorCode  string `json:"providerErrorCode"`
	ProviderStopReason string `json:"providerStopReason"`
	Phase              string `json:"phase"`
	ReasonCode         string `json:"reasonCode"`
	StopReason         string `json:"stopReason"`
	ProviderEvent      string `json:"providerEvent"`
	ProviderStatus     string `json:"providerStatus"`
	NetworkCode        string `json:"networkCode"`
	UpstreamStatus     int    `json:"upstreamStatus"`
	RequestCount       int    `json:"requestCount"`
	PartialOutput      bool   `json:"partialOutput"`
}

func piDiagnosticEnum(value string, allowed ...string) string {
	if value == "" {
		return "none"
	}
	for _, item := range allowed {
		if value == item {
			return value
		}
	}
	return "unrecognized"
}

func logPiFailure(ctx context.Context, runID string, err error, d piFailureDiagnostics, partialOutput, canContinue bool, durationMs int64) {
	attempt, _ := ctx.Value(apiAttemptKey{}).(string)
	status := d.UpstreamStatus
	if status < 100 || status > 599 {
		status = 0
	}
	count := d.RequestCount
	if count < 0 || count > 10000 {
		count = 0
	}
	level := slog.LevelError
	if errorKind(err) == ErrorCanceled {
		level = slog.LevelInfo
	}
	slog.Log(ctx, level, "pi.worker.failed",
		"requestId", requestID(ctx), "attemptId", attempt, "runId", runID,
		"durationMs", durationMs, "errorCode", errorKind(err),
		"phase", piDiagnosticEnum(d.Phase, "starting", "request", "provider_stream", "completion", "checkpoint", "worker_start", "worker_stream"),
		"reasonCode", piDiagnosticEnum(d.ReasonCode, "agent_failed", "http_error", "fetch_failed", "provider_error", "output_limit", "incomplete_response", "invalid_completion_status", "context_limit", "content_policy", "aborted", "missing_assistant", "empty_answer", "checkpoint_failed", "cancelled", "timeout", "worker_failed", "worker_interrupted", "event_incomplete", "invalid_event", "invalid_tool", "invalid_checkpoint", "invalid_completion", "unexpected_event", "worker_error"),
		"stopReason", piDiagnosticEnum(d.StopReason, "none", "stop", "length", "toolUse", "error", "aborted"),
		"providerEvent", piDiagnosticEnum(d.ProviderEvent, "none", "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done", "response.output_text.delta", "response.output_text.done", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.completed", "response.failed", "response.incomplete", "error", "message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop"),
		"providerStopReason", piDiagnosticEnum(d.ProviderStopReason, "none", "end_turn", "max_tokens", "tool_use", "refusal", "pause_turn", "stop_sequence", "sensitive", "stop", "length", "tool_calls", "content_filter", "function_call", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"),
		"providerErrorCode", piDiagnosticEnum(d.ProviderErrorCode, "none", "server_error", "api_error", "overloaded_error", "rate_limit_error", "rate_limit_exceeded", "authentication_error", "permission_error", "invalid_request_error", "context_length_exceeded", "model_not_found", "insufficient_quota", "content_policy_violation"),
		"providerStatus", piDiagnosticEnum(d.ProviderStatus, "none", "completed", "incomplete", "in_progress", "failed", "cancelled", "queued"),
		"networkCode", piDiagnosticEnum(d.NetworkCode, "none", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
		"upstreamStatus", status, "requestCount", count,
		"partialOutput", partialOutput || d.PartialOutput, "canContinue", canContinue)
}
