package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIEndpointSelection(t *testing.T) {
	for _, tt := range []struct{ url, override, vendor, protocol, base string }{
		{"https://api.openai.com", "", "openai", "openai", "https://api.openai.com/v1"},
		{"https://api.anthropic.com", "", "anthropic", "anthropic", "https://api.anthropic.com/v1"},
		{"https://generativelanguage.googleapis.com/v1beta", "", "google", "openai", "https://generativelanguage.googleapis.com/v1beta/openai"},
		{"https://api.moonshot.cn/v1", "", "moonshot", "openai", "https://api.moonshot.cn/v1"},
		{"https://open.bigmodel.cn/api/coding/paas/v4/", "", "zhipu", "openai", "https://open.bigmodel.cn/api/coding/paas/v4"},
		{"https://api.deepseek.com", "", "deepseek", "openai", "https://api.deepseek.com"},
		{"https://api.minimaxi.com", "", "minimax", "openai", "https://api.minimaxi.com/v1"},
		{"https://api.anthropic.com.evil.test/v1", "", "custom", "openai", "https://api.anthropic.com.evil.test/v1"},
		{"https://relay.test/claude", "", "custom", "openai", "https://relay.test/claude"},
		{"https://relay.test/v1", "anthropic", "custom", "anthropic", "https://relay.test/v1"},
		{"https://api.anthropic.com/v1", "openai", "anthropic", "openai", "https://api.anthropic.com/v1"},
		{"https://api.openai.com:8443/v1", "", "custom", "openai", "https://api.openai.com:8443/v1"},
		{"https://api.openai.com/not-api", "", "custom", "openai", "https://api.openai.com/not-api"},
	} {
		t.Run(tt.url+tt.override, func(t *testing.T) {
			got := resolveAPIEndpoint(APIConnection{URL: tt.url, Protocol: tt.override})
			want := apiEndpoint{tt.vendor, tt.protocol, tt.base}
			if got != want {
				t.Fatalf("%+v want %+v", got, want)
			}
		})
	}
}

type apiRoundTripper func(*http.Request) (*http.Response, error)

func (f apiRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Capture the actual HTTP payload with official URLs, without real credentials
// or external network calls. Tests in this package do not run in parallel.
func TestSevenProviderWireParameters(t *testing.T) {
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	for _, tt := range []struct{ url, model, level, field, value, thinking string }{
		{"https://api.openai.com", "gpt-5", "medium", "reasoning_effort", "medium", ""},
		{"https://api.anthropic.com", "claude-sonnet-4-6", "high", "output_config", "high", "adaptive"},
		{"https://generativelanguage.googleapis.com/v1beta", "gemini-3-pro-preview", "medium", "reasoning_effort", "high", ""},
		{"https://api.moonshot.ai/v1", "kimi-k3", "medium", "reasoning_effort", "high", ""},
		{"https://api.moonshot.ai/v1", "kimi-k2.6", "high", "", "", "enabled"},
		{"https://api.z.ai/api/paas/v4", "glm-5.3", "medium", "reasoning_effort", "high", "enabled"},
		{"https://api.z.ai/api/paas/v4", "glm-5.2", "low", "reasoning_effort", "high", "enabled"},
		{"https://api.deepseek.com", "deepseek-flash", "medium", "reasoning_effort", "high", "enabled"},
		{"https://api.minimax.io/v1", "MiniMax-M3.1-Flash-Preview", "max", "reasoning_effort", "max", "adaptive"},
		{"https://api.minimax.io/v1", "MiniMax-M2.7", "high", "", "", ""},
		{"https://relay.test/v1", "claude-sonnet-4-6", "medium", "reasoning_effort", "medium", ""},
		{"https://relay.test/v1", "gemini-3-pro-preview", "medium", "reasoning_effort", "medium", ""},
		{"https://api.openai.com/v1", "gpt-4o", "high", "", "", ""},
		{"https://api.openai.com/v1", "future-model", "high", "", "", ""},
	} {
		t.Run(tt.model+tt.url, func(t *testing.T) {
			calls := 0
			http.DefaultTransport = apiRoundTripper(func(req *http.Request) (*http.Response, error) {
				calls++
				var body map[string]any
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if _, ok := body["temperature"]; ok {
					t.Fatal("unexpected sampling override")
				}
				if tt.field == "" {
					if _, ok := body["reasoning_effort"]; ok {
						t.Fatal("sent unsupported effort")
					}
				} else if tt.field == "output_config" {
					if body[tt.field].(map[string]any)["effort"] != tt.value {
						t.Fatal(body[tt.field])
					}
					if req.URL.Path != "/v1/messages" || req.Header.Get("x-api-key") != "test-key" || req.Header.Get("Authorization") != "" || req.Header.Get("anthropic-version") == "" {
						t.Fatal("wrong native authentication or path")
					}
					for _, key := range []string{"reasoning_effort", "stream_options", "n"} {
						if _, ok := body[key]; ok {
							t.Fatal("OpenAI field in native request", key)
						}
					}
				} else if body[tt.field] != tt.value {
					t.Fatalf("%s = %v want %s", tt.field, body[tt.field], tt.value)
				}
				thinking, ok := body["thinking"].(map[string]any)
				if tt.thinking == "" && ok {
					t.Fatal("unexpected thinking", thinking)
				}
				if tt.thinking != "" && thinking["type"] != tt.thinking {
					t.Fatal(thinking)
				}
				wire := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
				if tt.field == "output_config" {
					wire = anthropicTestWire("ok")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(wire))}, nil
			})
			result, err := streamCompletion(t.Context(), APIConnection{URL: tt.url, Key: "test-key"}, completionRequest{Model: tt.model, Effort: tt.level}, AIInput{Prompt: "private"}, nil)
			if err != nil || result.Text != "ok" || calls != 1 {
				t.Fatalf("%+v %v calls=%d", result, err, calls)
			}
			document, err := toolCompletion(t.Context(), APIConnection{URL: tt.url, Key: "test-key"}, completionRequest{Model: tt.model, Effort: tt.level}, []toolCompletionMessage{{Role: "system", Content: "document instructions"}, {Role: "user", Content: "private"}}, nil)
			if err != nil || document.Text != "ok" || calls != 2 {
				t.Fatalf("document request: %+v %v calls=%d", document, err, calls)
			}
		})
	}
}
func TestUnknownAdvertisedEffortAndFingerprint(t *testing.T) {
	e := resolveAPIEndpoint(APIConnection{URL: "https://relay.test/v1"})
	r := reasoningRule(e, "gpt-5", []string{"off", "on"})
	if r.resolve("medium") != "" || r.info().Mode != "unknown" {
		t.Fatal(r)
	}
	c := AIConfig{API: APIConnection{URL: "https://relay.test/v1"}}
	old := configPrint(c, "api:model")
	c.API.Protocol = "anthropic"
	if configPrint(c, "api:model") == old {
		t.Fatal("protocol did not invalidate capability")
	}
}
func TestCustomAnthropicProtocolAndImage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/messages" {
			t.Fatal(r.URL.Path)
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["output_config"].(map[string]any)["effort"] != "medium" {
			t.Fatal(payload)
		}
		messages := payload["messages"].([]any)
		parts := messages[0].(map[string]any)["content"].([]any)
		if parts[1].(map[string]any)["type"] != "image" {
			t.Fatal(parts)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, anthropicTestWire("ok"))
	}))
	defer upstream.Close()
	_, err := streamCompletion(context.Background(), APIConnection{URL: upstream.URL, Protocol: "anthropic"}, completionRequest{Model: "custom", Effort: "medium"}, AIInput{Prompt: "image", Image: []byte{1}}, nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestProviderModelBoundaries(t *testing.T) {
	for _, tt := range []struct{ url, model, mode, requested, want string }{
		{"https://api.openai.com", "gpt-6.1-sol", "levels", "max", "max"},
		{"https://api.openai.com", "gpt-5.5", "levels", "max", "xhigh"},
		{"https://generativelanguage.googleapis.com", "gemini-2.5-flash-image", "unknown", "medium", ""},
		{"https://api.minimax.io", "MiniMax-M2-future", "unknown", "high", ""},
		{"https://api.anthropic.com", "claude-haiku-4-5-20251001", "budget", "high", "8192"},
	} {
		r := reasoningRule(resolveAPIEndpoint(APIConnection{URL: tt.url}), tt.model, nil)
		if r.Mode != tt.mode || r.resolve(tt.requested) != tt.want {
			t.Fatalf("%s: %+v", tt.model, r)
		}
	}
	r := reasoningRule(resolveAPIEndpoint(APIConnection{URL: "https://api.moonshot.ai"}), "kimi-k2-thinking", nil)
	if r.Mode != "fixed" || r.Thinking != "" {
		t.Fatalf("K2 Thinking must not receive a hybrid thinking toggle: %+v", r)
	}
}

func TestClaudeFableAndMythosEffort(t *testing.T) {
	for _, model := range []string{"claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5"} {
		for _, level := range []string{"low", "medium", "high", "xhigh", "max"} {
			r := reasoningRule(resolveAPIEndpoint(APIConnection{URL: "https://api.anthropic.com"}), model, nil)
			p := map[string]any{}
			r.apply(p, "anthropic", level, r.resolve(level))
			if r.Mode != "levels" || r.info().Mappings["medium"] != "medium" || p["output_config"].(map[string]string)["effort"] != level || p["thinking"].(map[string]any)["type"] != "adaptive" || p["max_tokens"] != 32768 {
				t.Fatalf("%s %s: %+v", model, level, p)
			}
			relay := reasoningRule(resolveAPIEndpoint(APIConnection{URL: "https://relay.test/v1"}), model, nil)
			if relay.Source == "official" || relay.Thinking != "" || relay.resolve("max") != "high" {
				t.Fatal(relay)
			}
		}
	}
}
