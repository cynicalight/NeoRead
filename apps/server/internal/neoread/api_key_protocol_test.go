package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestAPIProtocolValidationAndLegacyDisplay(t *testing.T) {
	for _, protocol := range []string{"", "auto", "openai", "responses", "anthropic"} {
		if validateAPIProtocol(protocol) != nil {
			t.Fatal("rejected", protocol)
		}
	}
	if validateAPIProtocol("google") == nil {
		t.Fatal("accepted unknown protocol")
	}
	s := testServer(t)
	legacy := AIConfig{Primary: "api", API: APIConnection{URL: "https://api.anthropic.com", Key: "sk-private", Protocol: "auto"}, Models: map[string]string{}}
	passModels(&legacy, map[string]bool{"claude-sonnet-4-6": false})
	if err := s.writeAIConfig(legacy); err != nil {
		t.Fatal(err)
	}
	shown := publicConfig(s.aiConfig())
	if shown.API.Protocol != "anthropic" {
		t.Fatalf("legacy protocol shown as %q", shown.API.Protocol)
	}
	// 设置页原样回存推断出的协议时，旧值与检测结果保持不变。
	body := `{"primary":"api","models":{},"api":{"url":"https://api.anthropic.com","protocol":"anthropic","hasKey":true},"textAPI":{"url":"","model":"","hasKey":false},"imageAPI":{"url":"","model":"","hasKey":false},"capabilities":{}}`
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(body)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if saved := s.aiConfig(); saved.API.Protocol != "auto" || !capable(saved, "api:claude-sonnet-4-6", false) {
		t.Fatalf("legacy protocol rewritten: %q", saved.API.Protocol)
	}
	body = strings.Replace(body, `"protocol":"anthropic"`, `"protocol":"responses"`, 1)
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(body)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if saved := s.aiConfig(); saved.API.Protocol != "responses" || resolveAPIEndpoint(saved.API).Protocol != "responses" {
		t.Fatalf("explicit protocol not saved: %q", saved.API.Protocol)
	}
}

// Responses translation sends each batch independently.
func TestAPIKeyResponsesTranslation(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer sk-test" {
			w.WriteHeader(404)
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, responsesTestWire("译文"))
	}))
	t.Cleanup(upstream.Close)
	adapter := apiAgentAdapter{conn: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test", Protocol: "responses"}, text: apiModelChoice{"gpt-test", "high"}, catalog: func(context.Context) ([]AgentModel, error) { return nil, fmt.Errorf("catalog unavailable") }}
	var metrics []ModelTokens
	for _, prompt := range []string{"batch-1", "batch-2"} {
		result, err := adapter.Stream(t.Context(), GenerateRequest{AIInput{Prompt: prompt, SystemPrompt: "translate"}}, func(e ProviderEvent) error {
			metrics = append(metrics, e.Metrics...)
			return nil
		})
		if err != nil || result.Text != "译文" {
			t.Fatalf("result=%+v err=%v", result, err)
		}
	}
	if len(bodies) != 2 || bodies[0]["instructions"] != "translate" || jsonText(bodies[0]["reasoning"]) != `{"effort":"high"}` {
		t.Fatalf("first request: %+v", bodies)
	}
	input, _ := bodies[1]["input"].([]any)
	if len(input) != 1 || !strings.Contains(jsonText(input[0]), "batch-2") || strings.Contains(jsonText(bodies[1]), "译文") {
		t.Fatalf("batch carried history: %s", jsonText(input))
	}
	if len(metrics) == 0 || metrics[0].Tokens == nil || metrics[0].Tokens.TotalTokens != 12 {
		t.Fatalf("usage not reported: %+v", metrics)
	}
}

// API requests include the catalog output limit.
func TestAPIKeyCatalogOutputLimit(t *testing.T) {
	var body map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, responsesTestWire("ok"))
	}))
	t.Cleanup(upstream.Close)
	adapter := apiAgentAdapter{conn: APIConnection{URL: upstream.URL, Key: "sk-test", Protocol: "responses"}, text: apiModelChoice{"gpt-test", "high"}, catalog: func(context.Context) ([]AgentModel, error) {
		return []AgentModel{{ID: "gpt-test", MaxOutputTokens: 4096}}, nil
	}}
	if _, err := adapter.Stream(t.Context(), GenerateRequest{AIInput{Prompt: "hi"}}, nil); err != nil {
		t.Fatal(err)
	}
	if body["max_output_tokens"] != float64(4096) {
		t.Fatalf("output limit not sent: %s", jsonText(body))
	}
}
