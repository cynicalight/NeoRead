package neoread

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBYOKFailedRunContinuesWithoutRepeatingTools(t *testing.T) {
	piTestRuntime(t)
	s, _ := prepareConversationFixture(t)
	var models, searches atomic.Int32
	var available atomic.Bool
	resumedModel := make(chan struct{}, 1)
	releaseResumed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if continueTestModels(w, r) {
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if strings.HasSuffix(r.URL.Path, "/tools/search") {
			searches.Add(1)
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"results":[{"title":"Saved source","url":"https://example.org/saved","summary":"SAVED TOOL RESULT"}]}`)
			return
		}
		n := models.Add(1)
		if n == 1 {
			writeToolReply(w, "web_search", `{"query":"public evidence"}`)
			return
		}
		if !strings.Contains(string(raw), "SAVED TOOL RESULT") {
			t.Error("successful tool result lost")
		}
		if !available.Load() {
			w.WriteHeader(502)
			io.WriteString(w, `{"error":{"message":"PRIVATE 502 body"}}`)
			return
		}
		select {
		case resumedModel <- struct{}{}:
		default:
		}
		select {
		case <-releaseResumed:
		case <-r.Context().Done():
			return
		}
		writeAPIReply(w, "依据[来源](https://example.org/saved)回答。")
	}))
	defer upstream.Close()
	config := configureContinueTestAPI(t, s, upstream.URL)
	response := request(t, s, "POST", "/api/documents/doc/chat-sessions", strings.NewReader(`{"provider":"api"}`))
	var chatSession ChatSession
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &chatSession) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	response = request(t, s, "POST", "/api/documents/doc/chat-sessions/"+chatSession.ID+"/chat", strings.NewReader(`{"provider":"api","prompt":"QUESTION-ONCE","context":"Original","webSearch":true}`))
	var run ChatRun
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &run) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	failed := awaitRunTest(t, s, run)
	if failed.Status != "failed" || !failed.Resumable || failed.Checkpoint == nil || !failed.Checkpoint.CanContinue || searches.Load() != 1 {
		t.Fatalf("failed=%+v models=%d searches=%d", failed.ChatRun, models.Load(), searches.Load())
	}
	if failed.Checkpoint.RunID != run.ID || !strings.Contains(string(failed.Checkpoint.Entries), "SAVED TOOL RESULT") {
		t.Fatal("durable tools/run identity missing")
	}
	history, _ := s.Store.chatHistory("doc", chatSession.ID)
	if len(history) != 1 {
		t.Fatalf("partial assistant saved: %d", len(history))
	}
	// 模拟持久化检查点后的进程退出：重启恢复只能标记 interrupted，不能补写回答。
	if _, err := s.Store.DB.Exec("UPDATE chat_runs SET body=json_set(body,'$.status','running','$.events',json(?)) WHERE id=?", jsonText(failed.Events[:len(failed.Events)-1]), run.ID); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.DB.Close() })
	s = NewServer(reopened, "test-secret", "")
	t.Cleanup(s.Close)
	latest, err := s.Store.latestChatRun(chatSession.ID)
	if err != nil || latest.Status != "interrupted" || !latest.Resumable {
		t.Fatalf("restart lost continuation: %+v %v", latest, err)
	}
	replay := request(t, s, "GET", "/api/documents/doc/chat-sessions/"+chatSession.ID+"/runs/"+run.ID+"/events", nil)
	if !strings.Contains(replay.Body.String(), "event: error") {
		t.Fatal("interrupted checkpoint replay lacks terminal event")
	}
	endpoint := "/api/documents/doc/chat-sessions/" + chatSession.ID + "/runs/" + run.ID + "/continue"
	originalUser := history[0]
	altered := originalUser
	altered.Content = "altered question"
	if _, err := s.Store.DB.Exec("UPDATE messages SET body=? WHERE id=?", jsonText(altered), originalUser.ID); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "POST", endpoint, nil); out.Code != 409 {
		t.Fatalf("changed question accepted: %d", out.Code)
	}
	if _, err := s.Store.DB.Exec("UPDATE messages SET body=? WHERE id=?", jsonText(originalUser), originalUser.ID); err != nil {
		t.Fatal(err)
	}
	// 模型、API 凭据和文档变化都必须在追加模型请求前拒绝。
	changed := s.aiConfig()
	changed.Models = map[string]string{"api": "other"}
	if err := s.writeAIConfig(changed); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "POST", endpoint, nil); out.Code != 409 {
		t.Fatalf("model change accepted: %d", out.Code)
	}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	changed = s.aiConfig()
	changed.API.Key = "changed-key"
	if err := s.writeAIConfig(changed); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "POST", endpoint, nil); out.Code != 409 {
		t.Fatalf("API credential change accepted: %d", out.Code)
	}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	document, _ := s.Store.Document("doc")
	path := s.Store.File(document)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "POST", endpoint, nil); out.Code != 409 {
		t.Fatalf("document change accepted: %d", out.Code)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	beforeModels := models.Load()
	available.Store(true)
	response = request(t, s, "POST", "/api/documents/doc/chat-sessions/"+chatSession.ID+"/runs/"+run.ID+"/continue", nil)
	var continued ChatRun
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &continued) != nil || continued.ID != run.ID {
		t.Fatal(response.Code, response.Body.String())
	}
	select {
	case <-resumedModel:
	case <-time.After(10 * time.Second):
		t.Fatal("resumed request did not start")
	}
	if out := request(t, s, "POST", endpoint, nil); out.Code != 409 {
		t.Fatalf("concurrent continue accepted: %d", out.Code)
	}
	close(releaseResumed)
	done := awaitRunTest(t, s, continued)
	if done.Status != "completed" || done.Resumable || searches.Load() != 1 || models.Load() != beforeModels+1 {
		t.Fatalf("done=%+v models=%d searches=%d", done.ChatRun, models.Load(), searches.Load())
	}
	history, _ = s.Store.chatHistory("doc", chatSession.ID)
	if len(history) != 2 || history[0].ID != run.UserMessageID || len(history[1].Tools) != 1 || len(history[1].WebSources) != 1 {
		t.Fatalf("saved history lost checkpoint or duplicated user: %+v", history)
	}
	response = request(t, s, "POST", "/api/documents/doc/chat-sessions/"+chatSession.ID+"/runs/"+run.ID+"/continue", nil)
	if response.Code != 409 {
		t.Fatal("completed run continued", response.Code)
	}
}

func TestChatCheckpointMustUpdateExistingRun(t *testing.T) {
	s := testServer(t)
	run := &chatRun{record: chatRunRecord{ChatRun: ChatRun{ID: "missing", SessionID: "missing"}}}
	if err := s.checkpointChat(run, &piCheckpoint{CanContinue: true}); errorKind(err) != ErrorSave {
		t.Fatalf("missing row checkpoint acknowledged: %v", err)
	}
}

func TestPiCheckpointCannotRebindChangedDocument(t *testing.T) {
	piTestRuntime(t)
	for _, mutateAt := range []string{"before-first-model", "while-request"} {
		t.Run(mutateAt, func(t *testing.T) {
			s, _ := prepareConversationFixture(t)
			document, _ := s.Store.Document("doc")
			path := s.Store.File(document)
			var checkpoint *piCheckpoint
			invalidated := false
			mutated := false
			mutate := func() {
				if mutated {
					return
				}
				mutated = true
				info, err := os.Stat(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(path, info.ModTime(), info.ModTime().Add(time.Second)); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if continueTestModels(w, r) {
					return
				}
				calls++
				if mutateAt == "while-request" {
					mutate()
				}
				w.WriteHeader(502)
				io.WriteString(w, `{}`)
			}))
			defer upstream.Close()
			chat := &chatInput{server: s, DocumentID: "doc", Question: "original question", CurrentText: "original selected text", piRunID: "run", piInvalidateCheckpoint: func() {
				invalidated = true
				if checkpoint != nil {
					checkpoint.CanContinue = false
				}
			}}
			chat.piCheckpoint = func(cp *piCheckpoint) error {
				checkpoint = cp
				if mutateAt == "before-first-model" {
					mutate()
				}
				return nil
			}
			_, err := streamPiChat(t.Context(), APIConnection{URL: upstream.URL, Key: "fixture"}, completionRequest{Model: "test", ContextWindow: 32000}, AIInput{Prompt: chat.Question, Chat: chat}, nil)
			if err == nil || !invalidated || checkpoint == nil || checkpoint.CanContinue {
				t.Fatalf("changed document remained resumable: err=%v invalidated=%v cp=%+v calls=%d", err, invalidated, checkpoint, calls)
			}
			current, _ := s.corpusFingerprint(document)
			if checkpoint.DocumentFingerprint == current {
				t.Fatal("old entries rebound to new document fingerprint")
			}
		})
	}
}

func continueTestSession(t *testing.T, s *Server) ChatSession {
	t.Helper()
	config := s.aiConfig()
	config.Primary = "api"
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "POST", "/api/documents/doc/chat-sessions", strings.NewReader(`{"provider":"api"}`))
	var session ChatSession
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &session) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	return session
}
func startContinueTestRun(t *testing.T, s *Server, session ChatSession) ChatRun {
	t.Helper()
	response := request(t, s, "POST", "/api/documents/doc/chat-sessions/"+session.ID+"/chat", strings.NewReader(`{"provider":"api","prompt":"Question","context":"Original","webSearch":true}`))
	var run ChatRun
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &run) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	return run
}
func TestCheckpointSaveFailureStopsBeforeModelRequest(t *testing.T) {
	piTestRuntime(t)
	s, _ := prepareConversationFixture(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if continueTestModels(w, r) {
			return
		}
		calls.Add(1)
		writeAPIReply(w, "unexpected")
	}))
	defer upstream.Close()
	configureContinueTestAPI(t, s, upstream.URL)
	session := continueTestSession(t, s)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON chat_runs WHEN json_extract(NEW.body,'$.piCheckpoint') IS NOT NULL BEGIN SELECT RAISE(ABORT,'checkpoint save blocked'); END`); err != nil {
		t.Fatal(err)
	}
	run := awaitRunTest(t, s, startContinueTestRun(t, s, session))
	if run.Status != "failed" || run.Resumable || calls.Load() != 0 {
		t.Fatalf("checkpoint failure was acknowledged: run=%+v calls=%d", run.ChatRun, calls.Load())
	}
}
func TestUnsafeCheckpointCannotContinueAfterCancelledTool(t *testing.T) {
	piTestRuntime(t)
	s, _ := prepareConversationFixture(t)
	started := make(chan struct{})
	releaseSearch := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if continueTestModels(w, r) {
			return
		}
		if strings.HasSuffix(r.URL.Path, "/tools/search") {
			io.Copy(io.Discard, r.Body)
			close(started)
			select {
			case <-r.Context().Done():
			case <-releaseSearch:
			}
			return
		}
		writeToolReply(w, "web_search", `{"query":"public"}`)
	}))
	defer upstream.Close()
	defer close(releaseSearch)
	configureContinueTestAPI(t, s, upstream.URL)
	session := continueTestSession(t, s)
	run := startContinueTestRun(t, s, session)
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("tool did not start")
	}
	record, err := s.Store.readChatRun(session.ID, run.ID)
	if err != nil || record.Checkpoint == nil || record.Checkpoint.CanContinue {
		t.Fatalf("side effect dispatched before unsafe checkpoint: %v %+v", err, record.ChatRun)
	}
	path := "/api/documents/doc/chat-sessions/" + session.ID + "/runs/" + run.ID
	if response := request(t, s, "POST", path+"/cancel", nil); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	record, err = s.Store.readChatRun(session.ID, run.ID)
	if err != nil || record.Resumable {
		t.Fatalf("in-flight tool became resumable: %v %+v", err, record.ChatRun)
	}
	if response := request(t, s, "POST", path+"/continue", nil); response.Code != 409 {
		t.Fatal("unsafe run continued", response.Code)
	}
}

func configureContinueTestAPI(t *testing.T, s *Server, url string) AIConfig {
	t.Helper()
	config := AIConfig{Primary: "api", API: APIConnection{URL: url, Key: "fixture"}, Models: map[string]string{"api": "test"}, APIModels: []string{"test"}, Capabilities: map[string]Capability{}, WebSearch: &WebSearchConfig{Provider: "deepseek", URL: url, Key: "search-fixture"}}
	passModels(&config, map[string]bool{"test": false})
	cap := config.Capabilities["api:test"]
	cap.Tools = "passed"
	cap.ToolSchemaVersion = documentToolSchemaVersion
	config.Capabilities["api:test"] = cap
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	return config
}

func continueTestModels(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/models") {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":[{"id":"test"}]}`)
		return true
	}
	return false
}
