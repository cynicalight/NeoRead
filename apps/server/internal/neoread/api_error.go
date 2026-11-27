package neoread

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"neoread.local/server/internal/diagnostics"
)

type apiTraceKey struct{}
type apiTrace struct {
	EffortField, ThinkingMode                                                           string
	ID, Parent, Vendor, Protocol, Model, Requested, Resolved, Source, Stage, UpstreamID string
	Visible                                                                             bool
}

func traceAPI(ctx context.Context, c APIConnection, model string) (context.Context, *apiTrace) {
	e := resolveAPIEndpoint(c)
	parent, _ := ctx.Value(apiAttemptKey{}).(string)
	t := &apiTrace{ID: id(), Parent: parent, Vendor: e.Vendor, Protocol: e.Protocol, Model: diagnostics.RedactText(model, c.Key)}
	return context.WithValue(ctx, apiTraceKey{}, t), t
}

type apiAttemptKey struct{}

func apiLog(ctx context.Context, level slog.Level, event string, attrs ...any) {
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		attrs = append(attrs, "apiRequestId", t.ID, "attemptId", t.Parent, "vendor", t.Vendor, "protocol", t.Protocol, "model", t.Model, "requestedEffort", t.Requested, "sentEffort", t.Resolved, "effortField", t.EffortField, "thinkingMode", t.ThinkingMode, "ruleSource", t.Source, "rulesVersion", apiRulesVersion, "partialOutput", t.Visible, "stage", t.Stage, "upstreamRequestId", t.UpstreamID)
	}
	attrs = append(attrs, "requestId", requestID(ctx))
	slog.Log(ctx, level, event, attrs...)
}

type apiFailure struct {
	*GenerationError
	Status                                       int
	Code, ProviderType, Param, UpstreamID, Stage string
}

var apiIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,128}$`)

func safeAPIIdentifier(value, key string) string {
	if !apiIdentifier.MatchString(value) || strings.HasPrefix(value, "sk-") || key != "" && strings.Contains(value, key) {
		return ""
	}
	return value
}
func apiRequestID(h http.Header, key string) string {
	for _, field := range []string{"x-request-id", "request-id", "x-goog-request-id", "x-trace-id", "trace-id"} {
		if value := safeAPIIdentifier(h.Get(field), key); value != "" {
			return value
		}
	}
	return ""
}
func (e *apiFailure) Unwrap() error { return e.GenerationError }
func providerFailure(ctx context.Context, c APIConnection, status int, header http.Header, body []byte, stage string) error {
	var envelope struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Error     struct {
			Code    json.RawMessage `json:"code"`
			Type    string          `json:"type"`
			Status  string          `json:"status"`
			Param   string          `json:"param"`
			Message string          `json:"message"`
		} `json:"error"`
		Base struct {
			Code    int    `json:"status_code"`
			Message string `json:"status_msg"`
		} `json:"base_resp"`
	}
	decoded := json.Unmarshal(body, &envelope) == nil
	code := strings.Trim(string(envelope.Error.Code), "\"")
	if code == "null" {
		code = ""
	}
	if envelope.Base.Code != 0 {
		code = fmt.Sprint(envelope.Base.Code)
	}
	kind := ErrorUpstream
	switch status {
	case 400, 422:
		kind = ErrorConfiguration
	case 401:
		kind = ErrorAuthentication
	case 403:
		kind = ErrorPermission
	case 404:
		kind = ErrorModel
	case 402:
		kind = ErrorBilling
	case 408, 504:
		kind = ErrorTimeout
	case 413:
		kind = ErrorContext
	case 429:
		kind = ErrorLimit
	}
	typ := envelope.Error.Type
	if typ == "" {
		typ = envelope.Error.Status
	}
	vendor := resolveAPIEndpoint(c).Vendor
	// Vendor numeric codes are scoped; generic gateways may return the named
	// OpenAI/Anthropic/Google codes, but numeric codes never cross vendors.
	for _, v := range []string{typ, code} {
		switch v {
		case "invalid_api_key", "authentication_error", "invalid_authentication_error", "incorrect_api_key_error", "UNAUTHENTICATED":
			kind = ErrorAuthentication
		case "permission_error", "permission_denied_error", "PERMISSION_DENIED":
			kind = ErrorPermission
		case "billing_error", "insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded":
			kind = ErrorBilling
		case "rate_limit_error", "rate_limit_exceeded", "slow_down", "RESOURCE_EXHAUSTED":
			kind = ErrorLimit
		case "context_length_exceeded", "request_too_large":
			kind = ErrorContext
		case "invalid_request_error":
			// This broad type also accompanies authentication, policy and quota
			// failures. Preserve meaningful HTTP classifications in those cases.
			if status >= 200 && status < 300 || status == 400 || status == 422 {
				kind = ErrorConfiguration
			}
		case "unsupported_parameter", "unsupported_value", "invalid_value", "INVALID_ARGUMENT":
			kind = ErrorConfiguration
		case "model_not_found", "not_found_error", "resource_not_found_error", "NOT_FOUND":
			kind = ErrorModel
		case "content_filter", "content_policy_violation":
			kind = ErrorContent
		case "overloaded_error", "server_is_overloaded", "api_error", "INTERNAL", "UNAVAILABLE":
			kind = ErrorUpstream
		}
	}
	if vendor == "zhipu" {
		switch code {
		case "1113", "1309":
			kind = ErrorBilling
		case "1211":
			kind = ErrorModel
		case "1210", "1212", "1213", "1214", "1215":
			kind = ErrorConfiguration
		case "1261":
			kind = ErrorContext
		case "1301":
			kind = ErrorContent
		case "1302", "1308", "1310":
			kind = ErrorLimit
		case "1305":
			kind = ErrorUpstream
		}
	}
	if vendor == "minimax" {
		switch code {
		case "1004":
			kind = ErrorAuthentication
		case "1008":
			kind = ErrorBilling
		case "1002":
			kind = ErrorLimit
		case "2013":
			kind = ErrorConfiguration
		}
	}
	// Only known parameter names are extracted, never arbitrary upstream prose.
	param := ""
	message := envelope.Error.Message + " " + envelope.Base.Message
	for _, p := range []string{"reasoning_effort", "output_config.effort", "thinking.type", "thinking.budget_tokens", "thinkingConfig", "thinkingLevel", "thinkingBudget", "thinking", "temperature", "top_p", "max_tokens", "max_completion_tokens", "maxOutputTokens", "stream_options", "model", "messages"} {
		if envelope.Error.Param == p || strings.Contains(message, p) {
			param = p
			break
		}
	}
	upstreamID := apiRequestID(header, c.Key)
	if upstreamID == "" {
		upstreamID = safeAPIIdentifier(envelope.RequestID, c.Key)
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		if upstreamID != "" {
			t.UpstreamID = upstreamID
		}
		t.Stage = stage
	}
	label := map[ErrorKind]string{ErrorConfiguration: "上游拒绝请求参数", ErrorAuthentication: "API 身份验证失败", ErrorPermission: "API 权限不足", ErrorModel: "API 模型或接口不存在或不可访问", ErrorBilling: "API 余额或配额不足", ErrorContext: "请求超过上下文或大小限制", ErrorContent: "上游内容策略拒绝请求", ErrorLimit: "API 限流或用量受限", ErrorUpstream: "上游请求失败，未能确定具体原因", ErrorTimeout: "上游请求超时"}[kind]
	if param != "" {
		label += "（参数：" + param + "）"
	}
	if status != 0 {
		label += fmt.Sprintf("；HTTP %d", status)
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		label += "；诊断编号：" + t.ID
	}
	// Unknown fields are fingerprinted, not copied: error bodies can echo input.
	knownCode := safeErrorCode(code)
	knownType := safeErrorCode(typ)
	sum := sha256.Sum256(body)
	apiLog(ctx, slog.LevelError, "api.error", "httpStatus", status, "errorCode", kind, "upstreamCode", knownCode, "upstreamType", knownType, "parameter", param, "jsonError", decoded, "errorBytes", len(body), "errorFingerprint", hex.EncodeToString(sum[:8]))
	return &apiFailure{&GenerationError{kind, label}, status, knownCode, knownType, param, upstreamID, stage}
}
func safeErrorCode(code string) string {
	const codes = " invalid_api_key authentication_error invalid_authentication_error incorrect_api_key_error UNAUTHENTICATED permission_error permission_denied_error PERMISSION_DENIED billing_error insufficient_quota credit_balance_exhausted organization_spend_limit_exceeded project_spend_limit_exceeded rate_limit_error rate_limit_exceeded slow_down RESOURCE_EXHAUSTED context_length_exceeded request_too_large invalid_request_error unsupported_parameter unsupported_value invalid_value INVALID_ARGUMENT model_not_found not_found_error resource_not_found_error NOT_FOUND content_filter content_policy_violation overloaded_error server_is_overloaded api_error INTERNAL UNAVAILABLE 1000 1001 1002 1003 1004 1008 1113 1200 1210 1211 1212 1213 1214 1215 1220 1261 1301 1302 1305 1308 1309 1310 2013 "
	if code == "" {
		return ""
	}
	if strings.Contains(codes, " "+code+" ") {
		return code
	}
	return "unrecognized"
}
func apiNetworkFailure(ctx context.Context, err error) error {
	kind := ErrorNetwork
	stage := "connect"
	var dns *net.DNSError
	var netErr net.Error
	var cert *tls.CertificateVerificationError
	var unknown x509.UnknownAuthorityError
	var record tls.RecordHeaderError
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		kind = ErrorCanceled
		stage = "cancelled"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		kind = ErrorTimeout
		stage = "timeout"
	case errors.As(err, &cert) || errors.As(err, &unknown) || errors.As(err, &record):
		stage = "tls"
	case errors.As(err, &dns):
		stage = "dns"
	case errors.As(err, &netErr) && netErr.Timeout():
		kind = ErrorTimeout
		stage = "timeout"
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.Stage = stage
	}
	apiLog(ctx, slog.LevelError, "api.error", "errorCode", kind)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return generationError(kind, "API 网络请求失败；请查看诊断日志")
}
func logAPIFinish(ctx context.Context, started time.Time, err error) {
	kind := ErrorKind("")
	level := slog.LevelInfo
	if err != nil {
		kind = errorKind(err)
		level = slog.LevelError
	}
	apiLog(ctx, level, "api.finish", "durationMs", time.Since(started).Milliseconds(), "errorCode", kind)
}

func hasAPIError(body []byte) bool {
	var v struct {
		Error json.RawMessage `json:"error"`
		Base  struct {
			Code int `json:"status_code"`
		} `json:"base_resp"`
	}
	return json.Unmarshal(body, &v) == nil && (len(v.Error) > 0 && string(v.Error) != "null" || v.Base.Code != 0)
}
