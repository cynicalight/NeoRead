package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func anthropicTestWire(text string) string {
	return "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" +
		fmt.Sprintf("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":%q}}\n\n", text) +
		"data: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
}
func TestAnthropicStreamBoundaries(t *testing.T) {
	wire := anthropicTestWire("你好")
	for _, tt := range []struct {
		name, wire string
		kind       ErrorKind
	}{
		{"complete", wire, ""},
		{"missing-stop", strings.ReplaceAll(wire, "data: {\"type\":\"message_stop\"}\n\n", ""), ErrorProtocol},
		{"missing-reason", strings.ReplaceAll(wire, "\"end_turn\"", "null"), ErrorProtocol},
		{"empty", anthropicTestWire(""), ErrorProtocol},
		{"length", strings.ReplaceAll(wire, "end_turn", "max_tokens"), ErrorLimit},
		{"tool", strings.ReplaceAll(wire, "end_turn", "tool_use"), ErrorCapability},
		{"error-after-output", strings.ReplaceAll(wire, "data: {\"type\":\"message_stop\"}", "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"private\"}}"), ErrorUpstream},
		{"text-without-start", strings.ReplaceAll(wire, "\"index\":0,\"delta\"", "\"index\":1,\"delta\""), ErrorProtocol},
		{"duplicate-start", strings.ReplaceAll(wire, "data: {\"type\":\"content_block_stop\",\"index\":0}", "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}"), ErrorProtocol},
	} {
		t.Run(tt.name, func(t *testing.T) {
			text := ""
			var tokens *TokenCounts
			result, err := readAnthropicStream(t.Context(), oneByteReader{strings.NewReader(tt.wire)}, APIConnection{}, func(e ProviderEvent) error {
				text += e.Text
				if len(e.Metrics) > 0 {
					tokens = e.Metrics[0].Tokens
				}
				return nil
			})
			if tt.kind == "" {
				if err != nil || result.Text != text || text != "你好" || tokens == nil || tokens.TotalTokens != 12 {
					t.Fatalf("%+v %v %+v", result, err, tokens)
				}
			} else if err == nil || errorKind(err) != tt.kind {
				t.Fatalf("%v want %s", err, tt.kind)
			}
		})
	}
}

func TestAnthropicThinkingIsNotAnswerText(t *testing.T) {
	thinking := "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"private reasoning\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"private signature\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n"
	wire := strings.Replace(anthropicTestWire("answer"), "data: {\"type\":\"content_block_start\"", thinking+"data: {\"type\":\"content_block_start\"", 1)
	text := ""
	result, err := readAnthropicStream(t.Context(), strings.NewReader(wire), APIConnection{}, func(e ProviderEvent) error { text += e.Text; return nil })
	if err != nil || result.Text != "answer" || text != "answer" {
		t.Fatalf("%+v %v %s", result, err, text)
	}
}

func TestAnthropicDocumentRetrievalConversation(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		calls++
		if r.URL.Path != "/messages" {
			t.Errorf("wrong protocol: %s", r.URL.Path)
		}
		var payload struct {
			System   json.RawMessage
			Messages []completionMessage
			Tools    []any
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if len(payload.Tools) > 0 || len(payload.System) == 0 {
			t.Error("invalid retrieval payload")
		}
		if !strings.Contains(jsonText(payload.Messages), "first-turn-marker") {
			t.Error("lost conversation history")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range strings.Split(anthropicTestWire("answer"), "\n\n") {
			if strings.HasPrefix(frame, "data: ") {
				var event struct{ Type string }
				if err := json.Unmarshal([]byte(strings.TrimPrefix(frame, "data: ")), &event); err != nil {
					t.Error(err)
				}
				fmt.Fprintf(w, "event: %s\n", event.Type)
			}
			if frame != "" {
				fmt.Fprintf(w, "%s\n\n", frame)
			}
		}
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	c := s.aiConfig()
	c.API.Protocol = "anthropic"
	passModels(&c, map[string]bool{"test": false})
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	for _, question := range []string{"first-turn-marker", "继续"} {
		r := conversationRequest(t, s, "api", question)
		if strings.Count(r.Body.String(), "event: done") != 1 {
			t.Fatal(r.Body)
		}
	}
	if calls != 2 {
		t.Fatalf("unexpected capability calls: %d", calls)
	}
	var raw string
	if err := s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE document_id='doc'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var state documentConversation
	if err := json.Unmarshal([]byte(raw), &state); err != nil || len(state.PiEntries) == 0 {
		t.Fatalf("conversation not persisted: %v %d", err, len(state.PiEntries))
	}
}

func TestAnthropicThinkingOutputSignal(t *testing.T) {
	for _, tt := range []struct {
		name, block, delta string
		want               int
	}{
		{"delta", `{"type":"thinking","thinking":""}`, `{"type":"thinking_delta","thinking":"private thought"}`, 1},
		{"initial", `{"type":"thinking","thinking":"private thought"}`, `{"type":"thinking_delta","thinking":"more private thought"}`, 1},
		{"empty", `{"type":"thinking","thinking":" "}`, `{"type":"thinking_delta","thinking":" "}`, 0},
		{"signature", `{"type":"thinking"}`, `{"type":"signature_delta","signature":"private signature"}`, 0},
		{"redacted", `{"type":"redacted_thinking","data":"private data"}`, "", 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			thinking := fmt.Sprintf("data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":%s}\n\n", tt.block)
			if tt.delta != "" {
				thinking += fmt.Sprintf("data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":%s}\n\n", tt.delta)
			}
			thinking += "data: {\"type\":\"content_block_stop\",\"index\":1}\n\ndata: {\"type\":\"ping\"}\n\n"
			wire := strings.Replace(anthropicTestWire("answer"), "data: {\"type\":\"content_block_start\"", thinking+"data: {\"type\":\"content_block_start\"", 1)
			signals, text := 0, ""
			result, err := readAnthropicStream(t.Context(), strings.NewReader(wire), APIConnection{}, func(e ProviderEvent) error {
				if e.OutputObserved {
					signals++
				}
				encoded, _ := json.Marshal(e)
				if strings.Contains(string(encoded), "private") || e.Reasoning != "" {
					t.Fatalf("thinking leaked: %s", encoded)
				}
				text += e.Text
				return nil
			})
			if err != nil || signals != tt.want || text != "answer" || result.Text != "answer" || result.Reasoning != "" {
				t.Fatalf("signals=%d want=%d result=%+v err=%v", signals, tt.want, result, err)
			}
		})
	}
}
