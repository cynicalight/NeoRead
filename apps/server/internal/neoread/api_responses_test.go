package neoread

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func responsesTestWire(text string) string {
	return "data: " + jsonText(map[string]any{"type": "response.output_text.delta", "delta": text}) + "\n\n" +
		`data: {"type":"response.completed","response":{"status":"completed","model":"gpt-test","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":4}}}}` + "\n\n"
}

func TestResponsesStreamErrorsAreClassified(t *testing.T) {
	for wire, kind := range map[string]ErrorKind{
		`data: {"type":"response.incomplete","response":{"status":"incomplete"}}` + "\n\n":     ErrorLimit,
		`data: {"type":"response.output_item.added","item":{"type":"function_call"}}` + "\n\n": ErrorCapability,
		`data: {"type":"response.refusal.delta","delta":"no"}` + "\n\n":                        ErrorContent,
	} {
		if _, err := readResponsesStream(t.Context(), strings.NewReader(wire), APIConnection{}, nil); errorKind(err) != kind {
			t.Fatalf("%s: %v", wire, err)
		}
	}
}

// 不支持工具的文档问答在 Responses 下改用同一组文本消息。
func TestResponsesDocumentCompletionWithoutTools(t *testing.T) {
	var body map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, responsesTestWire("回答"))
	}))
	t.Cleanup(upstream.Close)
	conn := APIConnection{URL: upstream.URL, Key: "sk-test", Protocol: "responses"}
	messages := []toolCompletionMessage{{Role: "system", Content: "rules"}, {Role: "user", Content: "问题"}}
	result, err := toolCompletion(t.Context(), conn, completionRequest{Model: "gpt-test"}, messages, nil)
	if err != nil || result.Text != "回答" || body["instructions"] != "rules" || !strings.Contains(jsonText(body["input"]), "问题") {
		t.Fatalf("result=%+v err=%v body=%+v", result, err, body)
	}
	if _, err = toolCompletion(t.Context(), conn, completionRequest{Model: "gpt-test"}, messages, []any{map[string]any{}}); errorKind(err) != ErrorCapability {
		t.Fatal("Responses tool rounds must be rejected until adapted", err)
	}
}

func TestOpenAIResponsesSharesOfficialEffortLevels(t *testing.T) {
	r := reasoningRule(resolveAPIEndpoint(APIConnection{URL: "https://api.openai.com", Protocol: "responses"}), "gpt-5.5", nil)
	payload := map[string]any{}
	r.apply(payload, "responses", "max", r.resolve("max"))
	if r.Mode != "levels" || jsonText(payload) != `{"reasoning":{"effort":"xhigh"}}` {
		t.Fatalf("rule=%+v payload=%s", r, jsonText(payload))
	}
}

func TestResponsesStreamRequiresTerminal(t *testing.T) {
	for _, wire := range []string{"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n", "data: {\"type\":\"response.incomplete\"}\n\n", "data: {\"error\":{\"message\":\"secret\"}}\n\n"} {
		if _, err := readResponsesStream(t.Context(), strings.NewReader(wire), APIConnection{}, nil); err == nil {
			t.Fatal("accepted incomplete response")
		}
	}

}
