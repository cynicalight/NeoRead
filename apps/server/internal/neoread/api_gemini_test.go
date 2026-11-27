package neoread

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func geminiTestWire(text string) string {
	return "data: " + jsonText(map[string]any{
		"modelVersion": "gemini-3-flash-preview",
		"candidates": []any{map[string]any{
			"content":      map[string]any{"role": "model", "parts": []any{map[string]any{"text": text}}},
			"finishReason": "STOP",
		}},
		"usageMetadata": map[string]any{
			"promptTokenCount":        10,
			"candidatesTokenCount":    2,
			"thoughtsTokenCount":      3,
			"cachedContentTokenCount": 4,
			"totalTokenCount":         15,
		},
	}) + "\n\n"
}

func geminiFunctionCallWire(id, name string, args any, signature string) string {
	fc := map[string]any{"name": name, "args": args}
	if id != "" {
		fc["id"] = id
	}
	part := map[string]any{"functionCall": fc}
	if signature != "" {
		part["thoughtSignature"] = signature
	}
	return "data: " + jsonText(map[string]any{
		"modelVersion": "gemini-3-flash-preview",
		"candidates": []any{map[string]any{
			"content":      map[string]any{"role": "model", "parts": []any{part}},
			"finishReason": "STOP",
		}},
	}) + "\n\n"
}

func TestGeminiEndpointAndReasoningRules(t *testing.T) {
	for _, raw := range []string{
		"https://generativelanguage.googleapis.com",
		"https://generativelanguage.googleapis.com/v1beta",
		"https://generativelanguage.googleapis.com/v1beta/openai",
	} {
		got := resolveAPIEndpoint(APIConnection{URL: raw, Protocol: "gemini"})
		want := apiEndpoint{Vendor: "google", Protocol: "gemini", Base: "https://generativelanguage.googleapis.com/v1beta"}
		if got != want {
			t.Fatalf("%s -> %+v, want %+v", raw, got, want)
		}
	}
	relay := resolveAPIEndpoint(APIConnection{URL: "https://relay.example/v1beta/", Protocol: "gemini"})
	if relay != (apiEndpoint{Vendor: "custom", Protocol: "gemini", Base: "https://relay.example/v1beta"}) {
		t.Fatalf("relay endpoint: %+v", relay)
	}

	official := resolveAPIEndpoint(APIConnection{URL: "https://generativelanguage.googleapis.com", Protocol: "gemini"})
	rLevel := reasoningRule(official, "models/gemini-3-pro-preview", nil)
	pLevel := map[string]any{}
	rLevel.apply(pLevel, "gemini", "medium", rLevel.resolve("medium"))
	applyOutputLimit(pLevel, "gemini", 65536)
	if rLevel.Mode != "levels" || jsonText(pLevel) != `{"generationConfig":{"maxOutputTokens":65536,"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"HIGH"}}}` {
		t.Fatalf("gemini 3 pro rule=%+v payload=%s", rLevel, jsonText(pLevel))
	}

	rBudget := reasoningRule(official, "gemini-2.5-pro", nil)
	pBudget := map[string]any{}
	rBudget.apply(pBudget, "gemini", "high", rBudget.resolve("high"))
	if rBudget.Mode != "budget" || jsonText(pBudget) != `{"generationConfig":{"thinkingConfig":{"includeThoughts":true,"thinkingBudget":8192}}}` {
		t.Fatalf("gemini 2.5 pro rule=%+v payload=%s", rBudget, jsonText(pBudget))
	}

	rRelay := reasoningRule(relay, "gemini-2.5-flash", nil)
	pRelay := map[string]any{}
	rRelay.apply(pRelay, "gemini", "medium", rRelay.resolve("medium"))
	if rRelay.Mode != "unknown" || len(pRelay) != 0 {
		t.Fatalf("unadvertised relay must not guess thinking mode: rule=%+v payload=%s", rRelay, jsonText(pRelay))
	}
}

func TestGeminiModelDiscoveryAndAuthHeader(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-goog-api-key") != "AIza-test-secret" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("key") != "" {
			t.Errorf("unexpected auth: header=%q auth=%q query=%q", r.Header.Get("x-goog-api-key"), r.Header.Get("Authorization"), r.URL.Query().Get("key"))
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1beta/models" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"models":[
				{"name":"models/text-embedding-004","displayName":"Embedding","supportedGenerationMethods":["embedContent"]},
				{"name":"models/gemini-2.5-pro","displayName":"Gemini 2.5 Pro","inputTokenLimit":1048576,"outputTokenLimit":65536,"supportedGenerationMethods":["generateContent","countTokens"]}
			]}`)
			return
		}
		if r.URL.Path != "/v1beta/models/gemini-2.5-pro:streamGenerateContent" || r.URL.Query().Get("alt") != "sse" {
			t.Errorf("unexpected generate path: %s", r.URL.String())
			w.WriteHeader(404)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		for _, forbidden := range []string{"messages", "stream", "n", "stream_options"} {
			if _, ok := body[forbidden]; ok {
				t.Errorf("OpenAI field %s leaked into Gemini body", forbidden)
			}
		}
		parts := body["contents"].([]any)[0].(map[string]any)["parts"].([]any)
		if len(parts) != 2 || parts[1].(map[string]any)["inlineData"] == nil {
			t.Errorf("expected text + inlineData parts: %s", jsonText(parts))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+jsonText(map[string]any{
			"candidates": []any{map[string]any{
				"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": "先思考", "thought": true}}},
			}},
		})+"\n\n"+geminiTestWire("图片正常"))
	}))
	t.Cleanup(upstream.Close)

	conn := APIConnection{URL: upstream.URL + "/v1beta", Key: "AIza-test-secret", Protocol: "gemini"}
	models, err := discoverAPIModels(context.Background(), conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "gemini-2.5-pro" || models[0].Name != "Gemini 2.5 Pro" || models[0].ContextWindow != 1048576 || models[0].MaxOutputTokens != 65536 {
		t.Fatalf("unexpected models: %+v", models)
	}

	var reasoning string
	var metrics []ModelTokens
	res, err := streamCompletion(t.Context(), conn, completionRequest{Model: "models/gemini-2.5-pro", MaxOutput: 4096}, AIInput{Prompt: "inspect", Image: []byte{1, 2, 3}}, func(e ProviderEvent) error {
		reasoning += e.Reasoning
		metrics = append(metrics, e.Metrics...)
		return nil
	})
	if err != nil || res.Text != "图片正常" || reasoning != "先思考" {
		t.Fatalf("res=%+v reasoning=%q err=%v", res, reasoning, err)
	}
	if len(metrics) != 1 || metrics[0].Tokens == nil || metrics[0].Tokens.InputTokens != 10 || metrics[0].Tokens.OutputTokens != 5 || metrics[0].Tokens.TotalTokens != 15 {
		t.Fatalf("unexpected metrics: %+v", metrics)
	}
}

func TestGeminiStreamErrorsAndTermination(t *testing.T) {
	for wire, kind := range map[string]ErrorKind{
		`data: {"candidates":[{"content":{"parts":[{"text":"cut"}]},"finishReason":"MAX_TOKENS"}]}` + "\n\n":                    ErrorLimit,
		`data: {"candidates":[{"content":{"parts":[{"text":"blocked"}]},"finishReason":"SAFETY"}]}` + "\n\n":                    ErrorContent,
		`data: {"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}` + "\n\n":                                                ErrorContent,
		`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":{}}}]},"finishReason":"STOP"}]}` + "\n\n": ErrorCapability,
		`data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}` + "\n\n":                                            ErrorProtocol,
		`data: {"candidates":[{"content":{"parts":[{"text":"unterminated"}]}`:                                                   ErrorProtocol,
	} {
		if _, err := readGeminiStream(t.Context(), strings.NewReader(wire), APIConnection{}, nil); errorKind(err) != kind {
			t.Fatalf("wire=%s got=%v (%s) want=%s", wire, err, errorKind(err), kind)
		}
	}
}

func TestGeminiDocumentToolRoundsAndThoughtSignatureReplay(t *testing.T) {
	var bodies []map[string]any
	const signature = "c2lnbmF0dXJlLXRlc3Q="
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "text/event-stream")
		if len(bodies) == 1 {
			io.WriteString(w,
				"data: "+jsonText(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": "草稿"}}}}}})+"\n\n"+
					geminiFunctionCallWire("call_1", "search_document", map[string]any{"query": "transformer"}, signature))
			return
		}
		io.WriteString(w, geminiTestWire("最终回答"))
	}))
	t.Cleanup(upstream.Close)

	conn := APIConnection{URL: upstream.URL, Key: "AIza-test", Protocol: "gemini"}
	messages := []toolCompletionMessage{{Role: "system", Content: "只读当前论文"}, {Role: "user", Content: "查找 transformer"}}
	var drafts []string
	first, err := toolCompletion(t.Context(), conn, completionRequest{Model: "gemini-3-flash-preview"}, messages, documentAPITools(), toolStreamCallbacks{
		Draft: func(text string, reset bool) error {
			if reset {
				text = "<reset>"
			}
			drafts = append(drafts, text)
			return nil
		},
	})
	if err != nil || len(first.Calls) != 1 || first.Calls[0].ID != "call_1" || first.Calls[0].Function.Name != "search_document" || first.Calls[0].Function.Arguments != `{"query":"transformer"}` {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	if strings.Join(drafts, "|") != "草稿|<reset>" {
		t.Fatalf("draft not withdrawn: %v", drafts)
	}
	assistant := toolCompletionMessage{Role: "assistant", Content: first.Text, Calls: first.Calls, GeminiParts: first.GeminiParts}
	if strings.Contains(jsonText(assistant), signature) {
		t.Fatal("opaque thoughtSignature leaked into generic message serialization")
	}
	messages = append(messages, assistant, toolCompletionMessage{Role: "tool", CallID: "call_1", Content: `{"items":[]}`})
	second, err := toolCompletion(t.Context(), conn, completionRequest{Model: "gemini-3-flash-preview"}, messages, documentAPITools())
	if err != nil || second.Text != "最终回答" {
		t.Fatalf("second=%+v err=%v", second, err)
	}
	replay := jsonText(bodies[1]["contents"])
	if !strings.Contains(replay, `"thoughtSignature":"`+signature+`"`) || !strings.Contains(replay, `"functionResponse":{"id":"call_1","name":"search_document","response":{"output":"{\"items\":[]}"}}`) {
		t.Fatalf("second contents missing signature or functionResponse:\n%s", replay)
	}
}

func TestGeminiDocumentToolProbe(t *testing.T) {
	var nonce string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		raw := jsonText(body["contents"])
		if !strings.Contains(raw, "functionResponse") {
			io.WriteString(w, geminiFunctionCallWire("", "neoread_probe", map[string]any{}, "cHJvYmUtc2ln"))
			return
		}
		start := strings.Index(raw, "neoread-")
		nonce = raw[start : start+strings.IndexByte(raw[start:], '"')]
		io.WriteString(w, geminiTestWire(nonce))
	}))
	t.Cleanup(upstream.Close)

	status, err := probeAPIDocumentTools(t.Context(), APIConnection{URL: upstream.URL, Key: "AIza-probe", Protocol: "gemini"}, "gemini-2.5-flash")
	if status != "passed" || err != nil || nonce == "" {
		t.Fatalf("status=%s err=%v nonce=%q", status, err, nonce)
	}
}
