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
}

func responsesFunctionCallWire(callID, name, arguments string) string {
	item := map[string]any{"type": "function_call", "id": "fc_1", "call_id": callID, "name": name, "arguments": arguments}
	return "data: " + jsonText(map[string]any{"type": "response.output_item.added", "item": map[string]any{"type": "function_call", "id": "fc_1", "call_id": callID, "name": name, "arguments": ""}}) + "\n\n" +
		"data: " + jsonText(map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": arguments}) + "\n\n" +
		"data: " + jsonText(map[string]any{"type": "response.output_item.done", "item": item}) + "\n\n" +
		`data: {"type":"response.completed","response":{"status":"completed","model":"gpt-test"}}` + "\n\n"
}

// Responses 的文档工具轮次：扁平工具定义、function_call 解析，以及下一轮回传调用与结果。
func TestResponsesDocumentToolRounds(t *testing.T) {
	var bodies []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "text/event-stream")
		if len(bodies) == 1 {
			io.WriteString(w, "data: "+jsonText(map[string]any{"type": "response.output_text.delta", "delta": "先查"})+"\n\n"+responsesFunctionCallWire("call_1", "search_document", `{"query":"x"}`))
			return
		}
		io.WriteString(w, responsesTestWire("答案"))
	}))
	t.Cleanup(upstream.Close)
	conn := APIConnection{URL: upstream.URL, Key: "sk-test", Protocol: "responses"}
	messages := []toolCompletionMessage{{Role: "system", Content: "rules"}, {Role: "user", Content: "问题"}}
	var drafts []string
	result, err := toolCompletion(t.Context(), conn, completionRequest{Model: "gpt-test"}, messages, documentAPITools(), toolStreamCallbacks{Draft: func(text string, reset bool) error {
		if reset {
			text = "<reset>"
		}
		drafts = append(drafts, text)
		return nil
	}})
	if err != nil || len(result.Calls) != 1 || result.Calls[0].ID != "call_1" || result.Calls[0].Function.Name != "search_document" || result.Calls[0].Function.Arguments != `{"query":"x"}` {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if strings.Join(drafts, "|") != "先查|<reset>" {
		t.Fatalf("draft not withdrawn before tool call: %q", drafts)
	}
	tools, _ := bodies[0]["tools"].([]any)
	first, _ := tools[0].(map[string]any)
	if len(tools) == 0 || first["type"] != "function" || first["name"] == nil || first["parameters"] == nil || first["function"] != nil {
		t.Fatalf("tools not flattened: %s", jsonText(bodies[0]["tools"]))
	}
	messages = append(messages, toolCompletionMessage{Role: "assistant", Content: result.Text, Calls: result.Calls, Reasoning: "hidden"}, toolCompletionMessage{Role: "tool", CallID: "call_1", Content: `{"hits":[]}`})
	result, err = toolCompletion(t.Context(), conn, completionRequest{Model: "gpt-test"}, messages, documentAPITools())
	if err != nil || result.Text != "答案" || len(result.Calls) != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	input := jsonText(bodies[1]["input"])
	want := `[{"content":[{"text":"问题","type":"input_text"}],"role":"user"},{"content":[{"text":"先查","type":"output_text"}],"role":"assistant"},{"arguments":"{\"query\":\"x\"}","call_id":"call_1","name":"search_document","type":"function_call"},{"call_id":"call_1","output":"{\"hits\":[]}","type":"function_call_output"}]`
	if input != want {
		t.Fatalf("second input:\n%s", input)
	}
	if strings.Contains(input, "hidden") || bodies[1]["instructions"] != "rules" {
		t.Fatalf("unexpected second request: %s", jsonText(bodies[1]))
	}
}

func TestResponsesToolStreamRejectsIncompleteCalls(t *testing.T) {
	for _, wire := range []string{
		`data: {"type":"response.output_item.added","item":{"type":"function_call"}}` + "\n\n" + `data: {"type":"response.completed","response":{"status":"completed"}}` + "\n\n",
		`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"","name":"x","arguments":"{}"}}` + "\n\n",
		responsesFunctionCallWire("call_1", "x", "{}")[:40],
	} {
		if _, err := readResponsesToolStream(t.Context(), strings.NewReader(wire), APIConnection{}); errorKind(err) != ErrorProtocol {
			t.Fatalf("%s: %v", wire, err)
		}
	}
	result, err := readResponsesToolStream(t.Context(), strings.NewReader(responsesFunctionCallWire("call_1", "x", "{bad")), APIConnection{})
	if err != nil || !result.Calls[0].InvalidArguments || result.Calls[0].Function.Arguments != "{}" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

// 工具检测对 Responses 连接实际往返一次，而不是直接判定不支持。
func TestResponsesDocumentToolProbe(t *testing.T) {
	var nonce string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		input := jsonText(body["input"])
		if !strings.Contains(input, "function_call_output") {
			io.WriteString(w, responsesFunctionCallWire("call_probe", "neoread_probe", "{}"))
			return
		}
		start := strings.Index(input, "neoread-")
		nonce = input[start : start+strings.IndexByte(input[start:], '"')]
		io.WriteString(w, responsesTestWire(nonce))
	}))
	t.Cleanup(upstream.Close)
	status, err := probeAPIDocumentTools(t.Context(), APIConnection{URL: upstream.URL, Key: "sk-test", Protocol: "responses"}, "gpt-test")
	if status != "passed" || err != nil || nonce == "" {
		t.Fatalf("status=%s err=%v nonce=%q", status, err, nonce)
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
