package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func configureDocumentAPI(t *testing.T, s *Server, url string) {
	t.Helper()
	d, _ := s.Store.Document("doc")
	if err := os.WriteFile(s.Store.File(d), []byte("fixture original"), 0600); err != nil {
		t.Fatal(err)
	}
	config := AIConfig{Primary: "api", API: APIConnection{URL: url}, Models: map[string]string{"api": "test"}, APIModels: []string{"test"}, Capabilities: map[string]Capability{}}
	passModels(&config, map[string]bool{"test": false})
	cap := config.Capabilities["api:test"]
	cap.Tools = "passed"
	cap.ToolSchemaVersion = documentToolSchemaVersion
	config.Capabilities["api:test"] = cap
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
}
func TestDocumentAgentFailureNeverCommitsAnAnswer(t *testing.T) {
	for _, mode := range []string{"forged-source", "save-failure"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := originalDocumentFixture(t)
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
					return
				}
				calls++
				switch mode {
				default:
					if mode == "forged-source" {
						writeAPIReply(w, "unread source [S999]")
					} else {
						writeAPIReply(w, "No evidence available")
					}
				}
			}))
			defer upstream.Close()
			configureDocumentAPI(t, s, upstream.URL)
			if mode == "save-failure" {
				if _, err := s.Store.DB.Exec(`CREATE TRIGGER fail_agent_answer BEFORE INSERT ON messages WHEN json_extract(NEW.body,'$.role')='assistant' BEGIN SELECT RAISE(ABORT,'save failed'); END`); err != nil {
					t.Fatal(err)
				}
			}
			response := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"api","prompt":"Compare chapters","context":""}`))
			if strings.Contains(response.Body.String(), "event: done") || !strings.Contains(response.Body.String(), "event: error") {
				t.Fatalf("false success: %s", response.Body.String())
			}
			var count int
			s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count)
			if count != 1 {
				t.Fatalf("partial answer saved: %d", count)
			}
			s.Store.DB.QueryRow("SELECT count(*) FROM chat_agent_runs WHERE json_extract(body,'$.status')='complete'").Scan(&count)
			if count != 0 {
				t.Fatal("failed run committed as complete")
			}
		})
	}
}
func TestDocumentAgentCancelAndDeleteStopAPI(t *testing.T) {
	for _, mode := range []string{"cancel", "delete", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := originalDocumentFixture(t)
			started := make(chan struct{})
			stopped := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
					return
				}
				_, _ = io.Copy(io.Discard, r.Body)
				close(started)
				<-r.Context().Done()
				close(stopped)
			}))
			defer upstream.Close()
			configureDocumentAPI(t, s, upstream.URL)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			r := httptest.NewRequest("POST", "http://127.0.0.1/api/documents/doc/chat", strings.NewReader(`{"provider":"api","prompt":"Read all sections","context":""}`)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer test-secret")
			w := httptest.NewRecorder()
			finished := make(chan struct{})
			go func() { s.Handler().ServeHTTP(w, r); close(finished) }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("API did not start")
			}
			switch mode {
			case "cancel":
				cancel()
			case "delete":
				response := request(t, s, "DELETE", "/api/documents/doc", nil)
				if response.Code != 204 {
					t.Fatal(response.Body.String())
				}
			case "shutdown":
				s.Close()
			}
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Fatal("chat not stopped")
			}
			select {
			case <-stopped:
			case <-time.After(5 * time.Second):
				t.Fatal("upstream not canceled")
			}
			if strings.Contains(w.Body.String(), "event: done") {
				t.Fatal("cancellation reported success")
			}
			var count int
			s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE json_extract(body,'$.role')='assistant'").Scan(&count)
			if count != 0 {
				t.Fatal("cancelled answer saved")
			}
		})
	}
}
func TestDocumentMCPAuthenticationRevocationAndAttemptScope(t *testing.T) {
	_, a := originalDocumentFixture(t)
	url, token, stop, err := serveDocumentMCP(a)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	call := func(auth, origin string) (int, string) {
		r, _ := http.NewRequest("POST", url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_outline","arguments":{}}}`))
		r.Header.Set("Authorization", "Bearer "+auth)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("MCP-Protocol-Version", "2025-11-25")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(data)
	}
	if status, _ := call("test-secret", ""); status != 401 {
		t.Fatal("main API token accepted")
	}
	if status, _ := call(token, "https://example.com"); status != 403 {
		t.Fatal("foreign origin accepted")
	}
	if status, body := call(token, ""); status != 200 || !strings.Contains(body, "firstBlockId") {
		t.Fatalf("MCP call %d %s", status, body)
	}
	foreign, _ := http.NewRequest("POST", url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	foreign.Host = "example.com"
	foreign.Header.Set("Authorization", "Bearer "+token)
	response, e := http.DefaultClient.Do(foreign)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("MCP SDK did not reject non-loopback Host")
	}
	a.resetAttempt("api")
	if _, body := call(token, ""); !strings.Contains(body, "尝试已结束") {
		t.Fatal("previous attempt capability reused")
	}
	stop()
	if _, e := http.Get(url); e == nil {
		t.Fatal("revoked endpoint reachable")
	}
}

func TestDocumentToolCapabilityVersionDoesNotInvalidateText(t *testing.T) {
	s := testServer(t)
	config := AIConfig{API: APIConnection{URL: "http://127.0.0.1:1"}, Models: map[string]string{"api": "test"}, Capabilities: map[string]Capability{}}
	passModels(&config, map[string]bool{"test": false})
	cap := config.Capabilities["api:test"]
	cap.Tools = "passed"
	cap.ToolSchemaVersion = "older-tool-schema"
	config.Capabilities["api:test"] = cap
	if e := s.writeAIConfig(config); e != nil {
		t.Fatal(e)
	}
	current := s.aiConfig()
	if !apiCapable(current, taskChat, false) || current.Capabilities["api:test"].Tools != "" {
		t.Fatal("stale tool check either survived or invalidated independent text capability")
	}
}
func TestDocumentReadReturnsTargetWithinResultBudget(t *testing.T) {
	s, _ := epubRangeFixture(t, nil)
	text := strings.Repeat("原始中文段落", 1200)
	os.WriteFile(s.Store.Root+"/cache/doc/a.xhtml", []byte("<html><body><p>"+text+"</p></body></html>"), 0600)
	corpus, err := s.documentCorpus(t.Context(), "doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &documentAgent{server: s, corpus: corpus, ctx: t.Context(), ID: id()}
	target := corpus.Passages[4].ID
	raw, err := a.call(t.Context(), "read_passage", json.RawMessage(fmt.Sprintf(`{"blockId":%q,"before":3,"after":3}`, target)))
	if err != nil || len(raw) > 12<<10 || !strings.Contains(string(raw), target) {
		t.Fatalf("target lost in bounded neighbor read: %s %v", raw, err)
	}
	var returned struct {
		Items []documentEvidence `json:"items"`
	}
	json.Unmarshal(raw, &returned)
	if len(returned.Items) != len(a.Evidence) {
		t.Fatal("unreturned passage entered evidence ledger")
	}
}

func TestDocumentAgentInvalidToolArgumentsCanFinish(t *testing.T) {
	s, _ := originalDocumentFixture(t)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		body, _ := io.ReadAll(r.Body)
		calls++
		if calls == 1 {
			writeToolReply(w, "read_passage", "{")
			return
		}
		if !strings.Contains(string(body), "invalid_arguments") {
			t.Error("model did not receive tool error")
		}
		writeAPIReply(w, "The passage could not be read.")
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	response := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"api","prompt":"Read the passage","context":""}`))
	if calls != 2 || !strings.Contains(response.Body.String(), "event: done") || !strings.Contains(response.Body.String(), "passage could not be read") {
		t.Fatal("tool argument error interrupted chat", calls, response.Body.String())
	}
}
