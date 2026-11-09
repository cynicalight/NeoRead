package neoread

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClaudeDocument plays Claude Code against the real NeoRead document MCP
// server named in --mcp-config, then streams stream-json like the CLI.
func fakeClaudeDocument(mode string) {
	emit := func(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
	prompt, _ := io.ReadAll(os.Stdin)
	if path := os.Getenv("NEOREAD_AGENT_CAPTURE"); path != "" {
		capture := strings.Join(os.Args, "\n") + "\nPROMPT:" + string(prompt) + "\nENV:" + os.Getenv("CLAUDE_CODE_DISABLE_CLAUDE_MDS") + os.Getenv("CLAUDE_CODE_DISABLE_AUTO_MEMORY")
		_ = os.WriteFile(path, []byte(capture), 0600)
	}
	var config struct {
		Servers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	for i, arg := range os.Args {
		if arg == "--mcp-config" && i+1 < len(os.Args) {
			_ = json.Unmarshal([]byte(os.Args[i+1]), &config)
		}
	}
	url := config.Servers[claudeDocumentServer].URL
	call := func(tool string, args any) map[string]any {
		body := jsonText(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}})
		r, _ := http.NewRequest("POST", url, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+os.Getenv("NEOREAD_DOCUMENT_MCP_TOKEN"))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("MCP-Protocol-Version", "2025-11-25")
		response, err := http.DefaultClient.Do(r)
		if err != nil || response.StatusCode != 200 {
			os.Exit(20)
		}
		defer response.Body.Close()
		var out struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
		}
		var result map[string]any
		if json.NewDecoder(response.Body).Decode(&out) != nil || len(out.Result.Content) == 0 || json.Unmarshal([]byte(out.Result.Content[0].Text), &result) != nil {
			os.Exit(21)
		}
		return result
	}
	servers := []any{map[string]string{"name": claudeDocumentServer, "status": "connected"}}
	if mode == "document-no-mcp" {
		servers = []any{map[string]string{"name": claudeDocumentServer, "status": "failed"}}
	}
	emit(map[string]any{"type": "system", "subtype": "init", "tools": claudeDocumentToolNames(), "mcp_servers": servers})
	stream := func(event any) { emit(map[string]any{"type": "stream_event", "event": event}) }
	text := func(s string) {
		stream(map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "text_delta", "text": s}})
	}
	stream(map[string]any{"type": "message_start"})
	text("先检索原文。")
	stream(map[string]any{"type": "content_block_start", "content_block": map[string]any{"type": "tool_use", "id": "toolu_1", "name": "mcp__" + claudeDocumentServer + "__search_document", "input": map[string]any{}}})
	stream(map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": "tool_use"}})
	found := call("search_document", map[string]any{"query": "cobalt"})
	items, _ := found["items"].([]any)
	if len(items) == 0 {
		os.Exit(22)
	}
	block, _ := items[0].(map[string]any)["blockId"].(string)
	read := call("read_passage", map[string]any{"blockId": block})
	source := ""
	if passages, _ := read["items"].([]any); len(passages) > 0 {
		source, _ = passages[0].(map[string]any)["sourceId"].(string)
	}
	if source == "" {
		os.Exit(23)
	}
	emit(map[string]any{"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}}}})
	if mode == "document-forged" {
		source = "S999"
	}
	answer := "cobalt 协议使用随机数 [" + source + "]。"
	stream(map[string]any{"type": "message_start"})
	text(answer)
	stream(map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": "end_turn"}})
	emit(map[string]any{"type": "result", "subtype": "success", "result": answer})
}

func claudeDocumentChat(t *testing.T, mode string) (*Server, string, string) {
	t.Helper()
	fakeAgent(t, "claude", mode)
	capture := filepath.Join(t.TempDir(), "args")
	t.Setenv("NEOREAD_AGENT_CAPTURE", capture)
	s, _ := originalDocumentFixture(t)
	d, _ := s.Store.Document("doc")
	if err := os.WriteFile(s.Store.File(d), []byte("fixture original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.writeAIConfig(AIConfig{Primary: "claude", Models: map[string]string{}, Capabilities: map[string]Capability{}}); err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"claude","prompt":"cobalt 协议用了什么？","context":""}`))
	args, _ := os.ReadFile(capture)
	return s, response.Body.String(), string(args)
}

func TestClaudeDocumentChatSavesVerifiedSources(t *testing.T) {
	s, body, args := claudeDocumentChat(t, "document")
	if !strings.Contains(body, "event: done") {
		t.Fatal(body)
	}
	if strings.Contains(args, "--safe-mode") || !strings.Contains(args, "--strict-mcp-config") || !strings.Contains(args, "disableAllHooks") || !strings.HasSuffix(args, "ENV:11") {
		t.Fatalf("isolation flags missing: %s", args)
	}
	if strings.Contains(args, "Bearer ") && !strings.Contains(args, "${NEOREAD_DOCUMENT_MCP_TOKEN}") {
		t.Fatal("MCP token passed in arguments")
	}
	// Commentary before the tool call is a draft and never reaches the answer.
	if !strings.Contains(body, "event: draft") || strings.Contains(body, `"text":"先检索原文。"}`+"\n\nevent: delta") {
		t.Fatal(body)
	}
	var raw string
	if err := s.Store.DB.QueryRow("SELECT body FROM messages WHERE json_extract(body,'$.role')='assistant'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var message Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatal(err)
	}
	var refs []struct {
		SourceID string `json:"sourceId"`
	}
	if err := json.Unmarshal(message.References, &refs); err != nil || len(refs) != 1 || !strings.Contains(message.Content, "["+refs[0].SourceID+"]") {
		t.Fatalf("source not saved: %s / %s", message.Content, message.References)
	}
	if strings.Contains(message.Content, "先检索原文") {
		t.Fatal("commentary saved as answer")
	}
	if len(message.Tools) != 1 || message.Tools[0].Tool != claudeDocumentServer+"/search_document" || message.Tools[0].Status != "completed" {
		t.Fatalf("tool activity: %+v", message.Tools)
	}
}

func TestClaudeDocumentChatRejectsUnsafeTurns(t *testing.T) {
	for _, mode := range []string{"document-no-mcp"} {
		t.Run(mode, func(t *testing.T) {
			s, body, _ := claudeDocumentChat(t, mode)
			if strings.Contains(body, "event: done") || !strings.Contains(body, "Claude 未能连接 NeoRead 文档工具") {
				t.Fatal(body)
			}
			var count int
			s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE json_extract(body,'$.role')='assistant'").Scan(&count)
			if count != 0 {
				t.Fatal("rejected answer saved")
			}
		})
	}
}

func TestClaudeDocumentStreamBoundaries(t *testing.T) {
	init := func(tools []string, servers string) string {
		return fmt.Sprintf(`{"type":"system","subtype":"init","tools":%s,"mcp_servers":%s}`, jsonText(tools), servers)
	}
	connected := `[{"name":"neoread_document","status":"connected"}]`
	for name, lines := range map[string][]string{
		"text before init":   {`{"type":"stream_event","event":{"type":"message_start"}}`},
		"foreign MCP server": {init(claudeDocumentToolNames(), `[{"name":"neoread_document","status":"connected"},{"name":"other","status":"connected"}]`)},
		"built-in tool":      {init(append(claudeDocumentToolNames(), "Bash"), connected)},
		"unauthorized call":  {init(claudeDocumentToolNames(), connected), `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"t","name":"Bash"}}}`},
		"result mismatch":    {init(claudeDocumentToolNames(), connected), `{"type":"stream_event","event":{"type":"message_start"}}`, `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}}`, `{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}`, `{"type":"result","subtype":"success","result":"b"}`},
		"max turns":          {init(claudeDocumentToolNames(), connected), `{"type":"result","subtype":"error_max_turns","is_error":true}`},
	} {
		t.Run(name, func(t *testing.T) {
			s := &claudeDocumentStream{chat: &chatInput{}, emit: func(ProviderEvent) error { return nil }, tools: map[string]ToolActivity{}}
			var err error
			for _, line := range lines {
				if err = s.line([]byte(line)); err != nil {
					break
				}
			}
			if err == nil || s.done {
				t.Fatal("accepted")
			}
		})
	}
}

func TestClaudeDocumentTranscriptKeepsNewestWithinBudget(t *testing.T) {
	history := []Message{{Role: "user", Content: "最早的问题"}, {Role: "assistant", Content: strings.Repeat("长回答", 400)}, {Role: "user", Content: "最近的问题"}, {Role: "assistant", Content: "最近的回答"}}
	text, used := claudeDocumentTranscript(history, 200)
	if !strings.Contains(text, "最近的问题") || strings.Contains(text, "最早的问题") || !strings.Contains(text, "更早的 2 条") || used > 200 {
		t.Fatalf("%d %s", used, text)
	}
	if text, used = claudeDocumentTranscript(nil, 200); text != "" || used != 0 {
		t.Fatal("empty history produced a transcript")
	}
}

// Unread labels stay in the saved answer without navigation metadata.
func TestClaudeDocumentChatKeepsUnreadLabelsWithoutReferences(t *testing.T) {
	s, body, _ := claudeDocumentChat(t, "document-forged")
	if !strings.Contains(body, "event: done") {
		t.Fatal(body)
	}
	var content, refs string
	if err := s.Store.DB.QueryRow("SELECT json_extract(body,'$.content'), coalesce(json_extract(body,'$.references'),'[]') FROM messages WHERE json_extract(body,'$.role')='assistant'").Scan(&content, &refs); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "[S999]") || refs != "[]" {
		t.Fatalf("%s / %s", content, refs)
	}
}
