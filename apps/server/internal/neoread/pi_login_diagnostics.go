package neoread

import (
	"log/slog"
	"strings"
)

type piLoginFailure struct {
	ReasonCode string `json:"reasonCode,omitempty"`
	SystemCode string `json:"systemCode,omitempty"`
	ErrorType  string `json:"errorType,omitempty"`
}

type piLoginDiagnostic struct {
	piLoginFailure
	Kind           string `json:"kind"`
	Stage          string `json:"stage"`
	Operation      string `json:"operation,omitempty"`
	CallbackPort   int    `json:"callbackPort,omitempty"`
	AddressFamily  string `json:"addressFamily,omitempty"`
	UpstreamStatus int    `json:"upstreamStatus,omitempty"`
	// A pointer preserves the distinction between an empty body and no response.
	UpstreamErrorBody *string `json:"upstreamErrorBody,omitempty"`
	DurationMs        int64   `json:"durationMs,omitempty"`
}

func loginDiagnosticValue(value, allowed string) string {
	if value == "" {
		return ""
	}
	for _, item := range strings.Fields(allowed) {
		if item == value {
			return value
		}
	}
	return "unrecognized"
}

func (f piLoginFailure) safe() piLoginFailure {
	return piLoginFailure{
		ReasonCode: loginDiagnosticValue(f.ReasonCode, "sdk_error unexpected_method unexpected_route state_mismatch missing_code login_cancelled network_timeout invalid_json invalid_token_response missing_account_id token_exchange_failed dns_failed tls_failed connection_refused connection_reset network_unreachable address_in_use address_unavailable system_error callback_bind_failed already_handled authorization_denied callback_completion_failed callback_server_failed callback_timeout http_rejected login_timeout"),
		ErrorType:  loginDiagnosticValue(f.ErrorType, "Error TypeError SyntaxError RangeError AggregateError DOMException AbortError TimeoutError SystemError unrecognized"),
		SystemCode: loginDiagnosticValue(f.SystemCode, "ENOTFOUND EAI_AGAIN ECONNREFUSED ECONNRESET ETIMEDOUT ENETUNREACH EHOSTUNREACH EPIPE EADDRINUSE EADDRNOTAVAIL EACCES EPERM ENOENT ENOSPC EROFS EMFILE ENFILE CERT_HAS_EXPIRED CERT_NOT_YET_VALID DEPTH_ZERO_SELF_SIGNED_CERT SELF_SIGNED_CERT_IN_CHAIN UNABLE_TO_VERIFY_LEAF_SIGNATURE UNABLE_TO_GET_ISSUER_CERT_LOCALLY ERR_TLS_CERT_ALTNAME_INVALID ERR_SSL_WRONG_VERSION_NUMBER UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_BODY_TIMEOUT UND_ERR_SOCKET UND_ERR_ABORTED ABORT_ERR"),
	}
}

func (s *Server) recordPiLoginDiagnostic(requestID, provider, runID string, d *piLoginDiagnostic) {
	if d == nil {
		return
	}
	kind := loginDiagnosticValue(d.Kind, "callback request sdk")
	if kind == "" || kind == "unrecognized" {
		return
	}
	stage := loginDiagnosticValue(d.Stage, "listen_start listening listen_failed received rejected accepted completed close_requested cancelled timeout failed start response error_body body_failed")
	failure := d.piLoginFailure.safe()
	attrs := []any{"requestId", requestID, "provider", provider, "runId", runID, "stage", stage, "reasonCode", failure.ReasonCode, "systemCode", failure.SystemCode, "errorType", failure.ErrorType}
	if kind == "request" && d.DurationMs >= 0 {
		attrs = append(attrs, "durationMs", d.DurationMs)
	}
	if kind == "callback" {
		if d.CallbackPort >= 0 && d.CallbackPort <= 65535 {
			attrs = append(attrs, "callbackPort", d.CallbackPort)
		}
		attrs = append(attrs, "addressFamily", loginDiagnosticValue(d.AddressFamily, "ipv4 ipv6 other"))
	}
	if kind == "request" {
		attrs = append(attrs, "operation", loginDiagnosticValue(d.Operation, "token_exchange authorization_request"))
		if d.UpstreamStatus >= 100 && d.UpstreamStatus <= 599 {
			attrs = append(attrs, "upstreamStatus", d.UpstreamStatus)
			if d.UpstreamStatus >= 400 && d.UpstreamErrorBody != nil {
				// User-requested exception: retain the entire failed authorization response
				// verbatim. The diagnostics store and exporters preserve this exact field.
				attrs = append(attrs, "upstreamErrorBody", *d.UpstreamErrorBody)
			}
		}
	}
	level := slog.LevelInfo
	if stage == "listen_failed" || stage == "rejected" || stage == "failed" || stage == "body_failed" || d.UpstreamStatus >= 400 {
		level = slog.LevelWarn
	}
	s.diagnosticEvent(level, "ai.connection."+kind, attrs...)
}
