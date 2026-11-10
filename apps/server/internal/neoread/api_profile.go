package neoread

import (
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// Rules apply only to exact official HTTPS origins and their documented API
// paths. A model name at a relay never selects a vendor or changes protocol.
// Sources and review date: docs/api-provider-compatibility.md.
const apiRulesVersion = "2026-10-13.1"

type apiEndpoint struct{ Vendor, Protocol, Base string }

// apiProtocols lists the supported API connection protocols.
var apiProtocols = []string{"openai", "responses", "anthropic"}

func validAPIProtocol(protocol string) bool { return slices.Contains(apiProtocols, protocol) }

func resolveAPIEndpoint(c APIConnection) apiEndpoint {
	e := apiEndpoint{"custom", "openai", strings.TrimRight(c.URL, "/")}
	u, err := url.Parse(c.URL)
	if err == nil && u.Scheme == "https" && u.User == nil && (u.Port() == "" || u.Port() == "443") {
		path := strings.TrimRight(u.Path, "/")
		switch strings.ToLower(u.Hostname()) {
		case "api.openai.com":
			if path == "" || path == "/v1" {
				e.Vendor = "openai"
				path = "/v1"
			}
		case "api.anthropic.com":
			if path == "" || path == "/v1" {
				e.Vendor = "anthropic"
				e.Protocol = "anthropic"
				path = "/v1"
			}
		case "generativelanguage.googleapis.com":
			if slices.Contains([]string{"", "/v1beta", "/v1beta/openai"}, path) {
				e.Vendor = "google"
				path = "/v1beta/openai"
			}
		case "api.moonshot.ai", "api.moonshot.cn":
			if path == "" || path == "/v1" {
				e.Vendor = "moonshot"
				path = "/v1"
			}
		case "open.bigmodel.cn", "api.z.ai":
			if slices.Contains([]string{"/api/paas/v4", "/api/coding/paas/v4"}, path) {
				e.Vendor = "zhipu"
			}
		case "api.deepseek.com":
			if path == "" || path == "/v1" {
				e.Vendor = "deepseek"
			}
		case "api.minimax.io", "api.minimaxi.com":
			if path == "" || path == "/v1" {
				e.Vendor = "minimax"
				path = "/v1"
			}
		}
		if e.Vendor != "custom" {
			u.Path = path
			e.Base = strings.TrimRight(u.String(), "/")
		}
	}
	if validAPIProtocol(c.Protocol) {
		e.Protocol = c.Protocol
	}
	return e
}

type APIEffortInfo struct {
	Mode     string            `json:"mode"` // levels, budget, fixed, unknown
	Note     string            `json:"note"`
	Mappings map[string]string `json:"mappings,omitempty"`
}
type apiReasoningRule struct {
	Mode, Source string
	Levels       []string
	Thinking     string
	Preserve     bool
	Split        bool
}

var datedModel = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)

func reasoningRule(e apiEndpoint, model string, advertised []string) apiReasoningRule {
	r := apiReasoningRule{Mode: "unknown", Source: "unverified"}
	m := strings.ToLower(datedModel.ReplaceAllString(model, ""))
	levels := func(values ...string) { r.Mode = "levels"; r.Levels = values; r.Source = "official" }
	fixed := func() { r.Mode = "fixed"; r.Source = "official" }
	// Selecting a protocol on a relay does not import model-name heuristics.
	if e.Vendor == "custom" {
		if validAPIProtocol(e.Protocol) {
			r.Levels = advertised
			if len(advertised) == 0 {
				r.Levels = []string{"low", "medium", "high"}
			} else {
				r.Source = "catalog"
			}
			r.Mode = "levels"
			if apiEffort("medium", r.Levels) == "" {
				r.Mode = "unknown"
			}
		}
		return r
	}
	switch e.Vendor {
	case "openai":
		// Chat Completions 与 Responses 同属 OpenAI 官方端点，强度档位相同。
		if e.Protocol == "anthropic" {
			return r
		}
		switch m {
		case "o1", "o3", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.1":
			levels("low", "medium", "high")
		case "gpt-5.2", "gpt-5.4", "gpt-5.5":
			levels("low", "medium", "high", "xhigh")
		case "gpt-5.6", "gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-astra":
			levels("low", "medium", "high", "xhigh", "max")
		case "o1-pro", "o3-pro", "gpt-5-pro":
			levels("high")
		case "gpt-5.2-pro", "gpt-5.4-pro":
			levels("medium", "high", "xhigh")
		case "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4-turbo", "gpt-3.5-turbo":
			fixed()
		}
	case "anthropic":
		if e.Protocol == "openai" {
			fixed()
			return r
		} // reasoning_effort is explicitly ignored.
		switch m {
		case "claude-opus-4-6", "claude-sonnet-4-6":
			levels("low", "medium", "high", "max")
			r.Thinking = "adaptive"
		case "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5":
			levels("low", "medium", "high", "xhigh", "max")
			r.Thinking = "adaptive"
		case "claude-opus-4-5", "claude-opus-4-5-20251101":
			levels("low", "medium", "high")
			r.Thinking = "budget"
		case "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-3-7-sonnet-20250219":
			r.Mode = "budget"
			r.Source = "official"
			r.Thinking = "budget"
		}
	case "google":
		if e.Protocol != "openai" {
			return r
		}
		if slices.Contains([]string{"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"}, m) {
			levels("low", "medium", "high")
		}
		if m == "gemini-3-pro-preview" {
			levels("low", "high")
		}
		if slices.Contains([]string{"gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.0-flash-001", "gemini-2.0-flash-lite-001"}, m) {
			fixed()
		}
	case "moonshot":
		if e.Protocol != "openai" {
			return r
		}
		if m == "kimi-k3" {
			levels("low", "high", "max")
			r.Preserve = true
		}
		switch m {
		case "kimi-k2.5", "kimi-k2.6":
			fixed()
			r.Thinking = "enabled"
		case "kimi-k2.7-code", "kimi-k2.7-code-highspeed":
			fixed()
			r.Thinking = "enabled"
			r.Preserve = true
		case "kimi-k2", "kimi-k2-0711-preview", "kimi-k2-0905-preview", "kimi-k2-turbo-preview", "kimi-k2-thinking", "kimi-k2-thinking-turbo":
			fixed()
		}
		if strings.HasPrefix(m, "moonshot-v1-") {
			fixed()
		}
	case "zhipu":
		if e.Protocol != "openai" {
			return r
		}
		if slices.Contains([]string{"glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"}, m) {
			levels("low", "high", "max")
			r.Thinking = "enabled"
		}
		if m == "glm-5.2" {
			levels("high", "max")
			r.Thinking = "enabled"
		}
		if slices.Contains([]string{"glm-5.1", "glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx", "glm-4.6", "glm-4.6v", "glm-4.5", "glm-4.5-air", "glm-4.5v"}, m) {
			fixed()
			r.Thinking = "enabled"
		}
	case "deepseek":
		if e.Protocol != "openai" {
			return r
		}
		if slices.Contains([]string{"deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4.1-pro"}, m) {
			levels("low", "high", "max")
			r.Thinking = "enabled"
		}
		if m == "deepseek-chat" || m == "deepseek-reasoner" {
			fixed()
		}
	case "minimax":
		if e.Protocol != "openai" {
			return r
		}
		if m == "minimax-m3.1-flash-preview" {
			levels("low", "medium", "high", "xhigh", "max")
			r.Thinking = "adaptive"
			r.Split = true
		}
		if slices.Contains([]string{"minimax-m3", "minimax-m2", "minimax-m2.1", "minimax-m2.1-highspeed", "minimax-m2.5", "minimax-m2.5-highspeed", "minimax-m2.7", "minimax-m2.7-highspeed"}, m) {
			fixed()
			r.Split = true
		}
	}
	return r
}

// These are intent-to-wire mappings, not measurements of actual model effort.
func (r apiReasoningRule) resolve(level string) string {
	if level == "" || r.Mode == "fixed" || r.Mode == "unknown" {
		return ""
	}
	if r.Mode == "budget" {
		return map[string]string{"low": "1024", "medium": "4096", "high": "8192", "max": "16384"}[level]
	}
	return apiEffort(level, r.Levels)
}
func (r apiReasoningRule) info() *APIEffortInfo {
	info := &APIEffortInfo{Mode: r.Mode, Mappings: map[string]string{}}
	switch {
	case r.Mode == "fixed":
		info.Note = "此模型使用固定／自动思考模式，不支持强度调节。"
	case r.Mode == "unknown":
		info.Note = "尚无此模型在当前协议下的强度规则，使用模型默认设置。"
	case r.Source == "unverified":
		info.Note = "按标准兼容协议发送；端点是否应用该强度尚未确认。"
	case r.Source == "catalog":
		info.Note = "按端点声明映射；调用成功不代表强度已生效。"
	case r.Mode == "budget":
		info.Note = "使用思考 token 预算映射强度。"
	default:
		info.Note = "按官方模型规则发送。"
	}
	for _, level := range []string{"low", "medium", "high", "max"} {
		info.Mappings[level] = r.resolve(level)
	}
	return info
}
func (r apiReasoningRule) apply(payload map[string]any, protocol, requested, resolved string) {
	if protocol == "responses" {
		if resolved != "" {
			payload["reasoning"] = map[string]string{"effort": resolved}
		}
		return
	}
	if protocol == "anthropic" {
		payload["max_tokens"] = 8192
		if r.Source == "official" && (r.Mode == "budget" || r.Mode == "levels") {
			payload["max_tokens"] = 32768
		}
		if r.Thinking == "adaptive" {
			payload["thinking"] = map[string]any{"type": "adaptive"}
		}
		if r.Thinking == "budget" {
			budget := map[string]int{"low": 1024, "medium": 4096, "high": 8192, "max": 16384}[requested]
			if budget == 0 {
				budget = 4096
			}
			payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		}
		if r.Mode == "levels" && resolved != "" {
			payload["output_config"] = map[string]string{"effort": resolved}
		}
		return
	}
	if r.Thinking != "" {
		thinking := map[string]any{"type": r.Thinking}
		if r.Preserve {
			thinking["keep"] = "all"
		}
		payload["thinking"] = thinking
	}
	if resolved != "" {
		payload["reasoning_effort"] = resolved
	}
	if r.Split {
		payload["reasoning_split"] = true
	}
}
