package neoread

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type liveWebCase struct {
	ReportTextLimitBytes int            `json:"reportTextLimitBytes"`
	Provider             string         `json:"provider"`
	Scenario             string         `json:"scenario"`
	Status               string         `json:"status"`
	ElapsedMs            int64          `json:"elapsedMs"`
	CancelRequested      bool           `json:"cancelRequested"`
	Messages             []Message      `json:"messages"`
	Events               []chatRunEvent `json:"events"`
}

// Opt in explicitly: these tests call real model/search services using only a
// public query and an isolated synthetic document. No real library is modified.
func TestLiveWebSearchLifecycle(t *testing.T) {
	switch os.Getenv("NEOREAD_TEST_WEB_PROVIDERS") {
	case "":
		t.Skip("set NEOREAD_TEST_WEB_PROVIDERS=api to authorize real model and search calls")
	case "api":
	default:
		t.Fatal("live search requires a Pi API connection")
	}
	const provider = "api"
	reports := []liveWebCase{}
	defer func() {
		if path := os.Getenv("NEOREAD_TEST_WEB_REPORT"); path != "" {
			data, _ := json.MarshalIndent(reports, "", "  ")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Error("cannot save sanitized live report")
			}
		}
	}()
	cfg := AIConfig{Primary: provider, Models: map[string]string{}, Capabilities: map[string]Capability{}}
	path := os.Getenv("NEOREAD_TEST_DOCUMENT_API_CONFIG")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("existing NeoRead API connection unavailable")
	}
	var stored savedConfig
	if json.Unmarshal(raw, &stored) != nil || !deepSeekSearchConnection(stored.Config.API) {
		t.Fatal("live test requires an existing official DeepSeek connection")
	}
	cfg.API = stored.Config.API
	model := stored.Config.Models["api"]
	if model == "" {
		t.Fatal("select an existing DeepSeek model")
	}
	cfg.Models["api"] = model
	cfg.APIModels = []string{model}
	cfg.Efforts = stored.Config.Efforts
	probeCtx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	status, err := probeAPIDocumentTools(probeCtx, cfg.API, model)
	cancel()
	if err != nil || status != "passed" {
		t.Fatalf("real tool handshake failed: %s %v", status, err)
	}
	cap := Capability{Text: true, Tools: "passed", ToolSchemaVersion: documentToolSchemaVersion, CheckedAt: now()}
	cap.Fingerprint = configPrint(cfg, apiCapabilityKey(model))
	cfg.Capabilities[apiCapabilityKey(model)] = cap
	cfg.WebSearch = &WebSearchConfig{Provider: "deepseek", URL: defaultSearchURL, Key: cfg.API.Key}
	s, _ := prepareConversationFixture(t)
	s.Token = id() + id()
	if err := s.writeAIConfig(cfg); err != nil {
		t.Fatal(err)
	}
	piTestRuntime(t)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	client := &http.Client{Timeout: 4 * time.Minute}
	call := func(method, path string, body any) *http.Response {
		t.Helper()
		var reader io.Reader
		if body != nil {
			data, _ := json.Marshal(body)
			reader = bytes.NewReader(data)
		}
		req, err := http.NewRequest(method, server.URL+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+s.Token)
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal("isolated NeoRead request failed", err)
		}
		if res.StatusCode >= 400 {
			defer res.Body.Close()
			data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
			t.Fatalf("NeoRead returned %d: %s", res.StatusCode, data)
		}
		return res
	}
	for _, scenario := range []string{"search-and-read", "cancel"} {
		start := time.Now()
		entry := liveWebCase{Provider: provider, Scenario: scenario, ReportTextLimitBytes: 400}
		reports = append(reports, entry)
		idx := len(reports) - 1
		res := call("POST", "/api/documents/doc/chat-sessions", map[string]string{"provider": provider})
		var session ChatSession
		err := json.NewDecoder(res.Body).Decode(&session)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		prompt := "请完成一次真实联网验证：先搜索 DeepSeek Search Fetch API 官方文档，再实际读取 https://api-docs.deepseek.com/zh-cn/guides/search/ 的正文。两步都必须调用工具，不能只凭已有知识。不要读取本地文件，不必检索当前合成文档。最后用两句中文说明 Search 与 Fetch 的区别，给出两个 endpoint，附该网页的 Markdown 链接。最多一次搜索和一次网页读取。"
		if scenario == "cancel" {
			prompt = "先联网搜索 DeepSeek Search Fetch API 官方文档，然后依次读取 https://api-docs.deepseek.com/zh-cn/guides/search/ 和 https://api-docs.deepseek.com/zh-cn/api/search/ ，全部读取后再回答。必须实际调用网页工具，不读取本地文件。"
		}
		res = call("POST", "/api/documents/doc/chat-sessions/"+session.ID+"/chat", map[string]any{"provider": provider, "prompt": prompt, "context": "", "webSearch": true, "userMessageId": id()})
		var run ChatRun
		err = json.NewDecoder(res.Body).Decode(&run)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		res = call("GET", "/api/documents/doc/chat-sessions/"+session.ID+"/runs/"+run.ID+"/events", nil)
		events := []chatRunEvent{}
		name := ""
		var data strings.Builder
		scanner := bufio.NewScanner(res.Body)
		scanner.Buffer(make([]byte, 4096), 4<<20)
		terminal := false
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "event:") {
				name = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			}
			if strings.HasPrefix(line, "data:") {
				data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
			if line != "" || name == "" {
				continue
			}
			raw := json.RawMessage(data.String())
			events = append(events, chatRunEvent{name, append(json.RawMessage(nil), raw...)})
			if name == "tool" {
				var tool ToolActivity
				json.Unmarshal(raw, &tool)
				t.Logf("provider=%s tool=%s status=%s", provider, tool.Kind, tool.Status)
			}
			if scenario == "cancel" && name == "tool" && !reports[idx].CancelRequested {
				var tool ToolActivity
				json.Unmarshal(raw, &tool)
				if tool.Status == "running" && (tool.Kind == "search" || tool.Kind == "web") {
					stop := call("POST", "/api/documents/doc/chat-sessions/"+session.ID+"/runs/"+run.ID+"/cancel", nil)
					stop.Body.Close()
					reports[idx].CancelRequested = true
				}
			}
			terminal = name == "done" || name == "error"
			name = ""
			data.Reset()
			if terminal {
				break
			}
		}
		scanErr := scanner.Err()
		res.Body.Close()
		reports[idx].ElapsedMs = time.Since(start).Milliseconds()
		// Keep only UI execution/answer events; never export provider thinking.
		for _, e := range events {
			if e.Event != "reasoning" {
				reports[idx].Events = append(reports[idx].Events, e)
			}
		}
		record, err := s.Store.readChatRun(session.ID, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		reports[idx].Status = record.Status
		messages, err := s.Store.chatHistory("doc", session.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range messages {
			m.Reasoning = ""
			for i := range m.WebSources {
				if len(m.WebSources[i].Text) > 400 {
					m.WebSources[i].Text = truncateChatText(m.WebSources[i].Text, 400)
				}
			}
			reports[idx].Messages = append(reports[idx].Messages, m)
		}
		if scanErr != nil || !terminal {
			t.Fatalf("live event stream incomplete: %v", scanErr)
		}
		if scenario == "cancel" {
			if !reports[idx].CancelRequested || record.Status != "cancelled" || len(messages) != 1 {
				t.Fatalf("cancellation did not stop the run: requested=%v status=%s messages=%d", reports[idx].CancelRequested, record.Status, len(messages))
			}
			for _, e := range events {
				if e.Event == "done" {
					t.Fatal("cancelled run falsely completed")
				}
			}
			t.Logf("provider=%s cancel status=%s elapsed=%dms", provider, record.Status, reports[idx].ElapsedMs)
			continue
		}
		if record.Status != "completed" || len(messages) != 2 {
			t.Fatalf("live answer not saved: status=%s error=%s messages=%d", record.Status, record.Error, len(messages))
		}
		answer := messages[1]
		searched, read := false, false
		for _, v := range answer.Tools {
			if v.Status == "completed" && v.Kind == "search" {
				searched = true
			}
			if v.Status == "completed" && v.Kind == "web" {
				read = true
			}
		}
		if !searched || !read || len(answer.WebSources) == 0 {
			t.Fatalf("missing real search/read events: search=%v read=%v sources=%d tools=%s", searched, read, len(answer.WebSources), jsonText(answer.Tools))
		}
		reopened, err := OpenStore(s.Store.Root)
		if err != nil {
			t.Fatal(err)
		}
		saved, err := reopened.chatHistory("doc", session.ID)
		reopened.DB.Close()
		if err != nil || len(saved) != 2 || len(saved[1].Tools) != len(answer.Tools) || len(saved[1].WebSources) != len(answer.WebSources) {
			t.Fatal("execution history did not survive reopening")
		}
		t.Logf("provider=%s saved=true search=true read=true tools=%d sources=%d elapsed=%dms", provider, len(answer.Tools), len(answer.WebSources), reports[idx].ElapsedMs)
	}
}
