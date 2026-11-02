package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func writeToolReply(w http.ResponseWriter, name, args string) {
	w.Header().Set("Content-Type", "text/event-stream")
	chunk := func(delta any, finish any) {
		b, _ := json.Marshal(map[string]any{"model": "deepseek-test", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
		fmt.Fprintf(w, "data: %s\n\n", b)
	}
	chunk(map[string]any{"reasoning_content": "opaque-continuation"}, nil)
	chunk(map[string]any{"content": "intermediate tool prose"}, nil)
	split := len(args) / 2
	chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call-" + id(), "type": "function", "function": map[string]string{"name": name, "arguments": args[:split]}}}}, nil)
	chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]string{"arguments": args[split:]}}}}, nil)
	chunk(map[string]any{}, "tool_calls")
	fmt.Fprint(w, "data: {\"model\":\"deepseek-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2,\"total_tokens\":10}}\n\ndata: [DONE]\n\n")
}
func TestDeepSeekDocumentAgentOverHTTP(t *testing.T) {
	s, _ := originalDocumentFixture(t)
	d, _ := s.Store.Document("doc")
	if e := os.WriteFile(s.Store.File(d), []byte("original fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := s.documentCorpus(t.Context(), "doc", nil); e != nil {
		t.Fatal(e)
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "deepseek-test"}}})
			return
		}
		var request struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
			Thinking struct {
				Type string `json:"type"`
			} `json:"thinking"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("bad request")
			w.WriteHeader(400)
			return
		}
		calls++
		if calls > 1 && calls < 7 {
			found := false
			for _, m := range request.Messages {
				if m.Role == "assistant" && len(m.Calls) > 0 {
					found = true
					if m.Reasoning != "opaque-continuation" {
						t.Error("DeepSeek continuation was lost")
					}
				}
			}
			if !found {
				t.Error("tool call IDs/history lost")
			}
		}
		block := func() string {
			var result struct {
				Items []struct {
					Block string `json:"blockId"`
				} `json:"items"`
			}
			if len(request.Messages) == 0 {
				return ""
			}
			text, _ := request.Messages[len(request.Messages)-1].Content.(string)
			json.Unmarshal([]byte(text), &result)
			if len(result.Items) == 0 {
				t.Error("search result unavailable")
				return ""
			}
			return result.Items[0].Block
		}
		switch calls {
		case 1:
			writeToolReply(w, "get_outline", "{}")
		case 2:
			writeToolReply(w, "search_document", `{"query":"COBALT-19"}`)
		case 3:
			writeToolReply(w, "read_passage", jsonText(map[string]any{"blockId": block(), "after": 1}))
		case 4:
			writeToolReply(w, "search_document", `{"query":"37"}`)
		case 5:
			writeToolReply(w, "read_passage", jsonText(map[string]any{"blockId": block()}))
		case 6:
			if len(request.Tools) == 0 {
				t.Error("answer was forced through a separate synthesis request")
			}
			joined := jsonText(request.Messages)
			if !strings.Contains(joined, "COBALT-19") || !strings.Contains(joined, "serial transactions") || !strings.Contains(joined, "37 transactions") {
				t.Error("original evidence lost in same-turn answer")
			}
			writeAPIReply(w, "COBALT-19, serial transactions [S2]. Experiment: 37 [S6].")

		default:
			t.Error("unbounded calls")
			w.WriteHeader(500)
		}
	}))
	defer upstream.Close()
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL, Key: "sk-test"}, Models: map[string]string{"api": "deepseek-test"}, APIModels: []string{"deepseek-test"}, Capabilities: map[string]Capability{}}
	passModels(&config, map[string]bool{"deepseek-test": false})
	cap := config.Capabilities["api:deepseek-test"]
	cap.Tools = "passed"
	cap.ToolSchemaVersion = documentToolSchemaVersion
	config.Capabilities["api:deepseek-test"] = cap
	if e := s.writeAIConfig(config); e != nil {
		t.Fatal(e)
	}
	w := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"api","prompt":"Compare nonce, condition and experiment","context":""}`))
	if calls != 6 || strings.Contains(w.Body.String(), "event: delta\ndata: {\"text\":\"intermediate tool prose") || strings.Count(w.Body.String(), "event: done") != 1 {
		t.Fatalf("calls=%d stream=%s", calls, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"phase":"indexing"`) || !strings.Contains(w.Body.String(), "正在检索“COBALT-19”") {
		t.Fatal("cached chat rebuilt its index or lost the actual search target")
	}
	var messages []Message
	if e := json.Unmarshal(request(t, s, "GET", "/api/documents/doc/messages", nil).Body.Bytes(), &messages); e != nil {
		t.Fatal(e)
	}
	if len(messages) != 2 || messages[1].Role != "assistant" {
		t.Fatalf("messages: %+v", messages)
	}
	var refs []documentEvidence
	if json.Unmarshal(messages[1].References, &refs) != nil || len(refs) != 2 {
		t.Fatal("citations not persisted")
	}
	sourceURL := "/api/documents/doc/messages/" + messages[1].ID + "/sources/S2"
	if response := request(t, s, "GET", sourceURL, nil); response.Code != 200 {
		t.Fatalf("source: %s", response.Body.String())
	}
	if response := request(t, s, "GET", "/api/documents/doc/messages/"+messages[1].ID+"/sources/S999", nil); response.Code == 200 {
		t.Fatal("forged source navigable")
	}
	var runs int
	s.Store.DB.QueryRow("SELECT count(*) FROM chat_agent_runs").Scan(&runs)
	if runs != 1 {
		t.Fatal("final result not committed once")
	}
	var usageCalls int
	s.Store.DB.QueryRow("SELECT count(*) FROM processing_usage WHERE document_id='doc'").Scan(&usageCalls)
	if usageCalls != calls {
		t.Fatalf("model calls double-counted or missing: usage=%d upstream=%d", usageCalls, calls)
	}
	// A source update invalidates the navigation without deleting historical evidence.
	if e := os.WriteFile(s.Store.File(d), []byte("changed fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	if response := request(t, s, "GET", sourceURL, nil); response.Code != 409 {
		t.Fatal("stale source still navigable")
	}
}
func TestAPIToolProbeAndNonAgentRetrieval(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []toolCompletionMessage `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		calls++
		if calls == 1 {
			writeToolReply(w, "neoread_probe", "{}")
		} else {
			writeAPIReply(w, request.Messages[len(request.Messages)-1].Content.(string))
		}
	}))
	defer upstream.Close()
	status, e := probeAPIDocumentTools(t.Context(), APIConnection{URL: upstream.URL}, "deepseek-test")
	if e != nil || status != "passed" || calls != 2 {
		t.Fatalf("probe %s %v calls=%d", status, e, calls)
	}
	s, a := originalDocumentFixture(t)
	var evidence string
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		if _, ok := request["tools"]; ok {
			t.Error("unsupported model received tools")
		}
		evidence = jsonText(request)
		writeAPIReply(w, "Original nonce [S2]")
	}))
	defer plain.Close()
	in := AIInput{Prompt: "COBALT-19", Chat: &chatInput{Question: "COBALT-19", Agent: a}}
	var text strings.Builder
	_, e = streamAPIDocumentChat(t.Context(), APIConnection{URL: plain.URL}, completionRequest{Model: "plain"}, in, func(v ProviderEvent) error { text.WriteString(v.Text); return nil })
	if e != nil || a.Mode != "retrieval" || !strings.Contains(evidence, "serial transactions") || text.Len() == 0 {
		t.Fatalf("retrieval: mode=%s %v", a.Mode, e)
	}
	_ = s
}
func TestToolDecoderRejectsIncompleteAndAmbiguousCalls(t *testing.T) {
	for _, body := range []string{
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}` + "\n\ndata: [DONE]\n\n",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"x","arguments":"{}"}}]},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n",
	} {
		if _, e := readToolCompletion(context.Background(), strings.NewReader(body)); e == nil {
			t.Fatal("incomplete/ambiguous tool call accepted")
		}
	}
}

func TestToolDecoderReportsInvalidArguments(t *testing.T) {
	body := `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"read_passage","arguments":"{"}}]},"finish_reason":"tool_calls"}]}` + "\n\ndata: [DONE]\n\n"
	result, err := readToolCompletion(context.Background(), strings.NewReader(body))
	if err != nil || len(result.Calls) != 1 || !result.Calls[0].InvalidArguments {
		t.Fatal("invalid arguments should become a tool error", result, err)
	}
	chunk := jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "b", "type": "function", "function": map[string]string{"name": "read_passage", "arguments": strings.Repeat("x", 5000)}}}}, "finish_reason": "tool_calls"}}})
	result, err = readToolCompletion(context.Background(), strings.NewReader("data: "+chunk+"\n\ndata: [DONE]\n\n"))
	if err != nil || len(result.Calls) != 1 || !result.Calls[0].InvalidArguments {
		t.Fatal("oversized arguments should become a tool error", result, err)
	}
}
