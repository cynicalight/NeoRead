package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func piTestRuntime(t *testing.T) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("pi integration tests require Node", err)
	}
	root, err := filepath.Abs("../../../agent")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "build.mjs")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build pi worker: %v\n%s", err, out)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_AGENT", filepath.Join(root, "dist/main.mjs"))
}
func createSessionTest(t *testing.T, s *Server) ChatSession {
	t.Helper()
	out := request(t, s, "POST", "/api/documents/doc/chat-sessions", strings.NewReader(`{"provider":"api"}`))
	if out.Code != 201 {
		t.Fatal(out.Code, out.Body.String())
	}
	var session ChatSession
	if err := json.Unmarshal(out.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	return session
}
func startSessionTest(t *testing.T, s *Server, session ChatSession, question string) ChatRun {
	t.Helper()
	out := request(t, s, "POST", "/api/documents/doc/chat-sessions/"+session.ID+"/chat", strings.NewReader(jsonText(map[string]any{"provider": "api", "prompt": question, "context": "", "userMessageId": id()})))
	if out.Code != 202 {
		t.Fatal(out.Code, out.Body.String())
	}
	var run ChatRun
	if err := json.Unmarshal(out.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	return run
}
func awaitRunTest(t *testing.T, s *Server, run ChatRun) chatRunRecord {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		record, err := s.Store.readChatRun(run.SessionID, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if record.Status != "running" {
			return record
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("run did not settle")
	return chatRunRecord{}
}
func TestChatSessionMigrationPreservesEvidence(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	original := Message{ID: "old-user", DocumentID: "doc", Role: "user", Content: "history", ReadingLocation: json.RawMessage(`{"type":"pdf","page":2}`), References: json.RawMessage(`[{"sourceId":"S1","contentHash":"same"}]`)}
	if err := s.Store.saveMessage(original); err != nil {
		t.Fatal(err)
	}
	if err := saveDocumentConversation(t.Context(), s.Store.DB, "doc", "codex", documentConversation{ID: "state", ConnectionKey: "key", LastMessageID: "existing-message"}); err != nil {
		t.Fatal(err)
	}
	out := request(t, s, "GET", "/api/documents/doc/chat-sessions", nil)
	if out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	var sessions []ChatSession
	_ = json.Unmarshal(out.Body.Bytes(), &sessions)
	if len(sessions) != 1 {
		t.Fatal(sessions)
	}
	messages, err := s.Store.chatHistory("doc", sessions[0].ID)
	if err != nil || len(messages) != 1 || messages[0].ID != original.ID || string(messages[0].References) != string(original.References) || string(messages[0].ReadingLocation) != string(original.ReadingLocation) {
		t.Fatal(messages, err)
	}
	state, err := s.Store.documentConversation(t.Context(), "doc", conversationProvider(sessions[0].ID, "codex"), "key")
	if err != nil || state.LastMessageID != "existing-message" {
		t.Fatal(state, err)
	}
	request(t, s, "GET", "/api/documents/doc/chat-sessions", nil)
	var count int
	_ = s.Store.DB.QueryRow("SELECT count(*) FROM chat_sessions").Scan(&count)
	if count != 1 {
		t.Fatal("migration not idempotent", count)
	}
}
func TestPiSessionsConcurrentCancelAndDetachedSubscriber(t *testing.T) {
	piTestRuntime(t)
	s, _ := prepareConversationFixture(t)
	started := make(chan string, 4)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		raw, _ := io.ReadAll(r.Body)
		text := string(raw)
		name := "ALPHA"
		if strings.Contains(text, "BETA") {
			name = "BETA"
		}
		if strings.Contains(text, "ALPHA") && strings.Contains(text, "BETA") {
			t.Error("session context mixed")
		}
		started <- name
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": name + " partial"}}}}))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-release:
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	a, b := createSessionTest(t, s), createSessionTest(t, s)
	runA, runB := startSessionTest(t, s, a, "ALPHA"), startSessionTest(t, s, b, "BETA")
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(10 * time.Second):
			t.Fatal("sessions did not run concurrently")
		}
	}
	conflict := request(t, s, "POST", "/api/documents/doc/chat-sessions/"+a.ID+"/chat", strings.NewReader(`{"provider":"api","prompt":"again","context":""}`))
	if conflict.Code != 409 {
		t.Fatal(conflict.Code, conflict.Body.String())
	}
	// Closing an SSE reader must not cancel its server-owned run.
	host := httptest.NewServer(s.Handler())
	defer host.Close()
	ctx, cancel := context.WithCancel(t.Context())
	req, _ := http.NewRequestWithContext(ctx, "GET", host.URL+"/api/documents/doc/chat-sessions/"+b.ID+"/runs/"+runB.ID+"/events", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	response, err := host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 64)
	_, _ = response.Body.Read(chunk)
	cancel()
	response.Body.Close()
	stopped := request(t, s, "POST", "/api/documents/doc/chat-sessions/"+a.ID+"/runs/"+runA.ID+"/cancel", nil)
	if stopped.Code != 200 {
		t.Fatal(stopped.Code)
	}
	aResult := awaitRunTest(t, s, runA)
	if aResult.Status != "cancelled" {
		t.Fatal(aResult.Status, aResult.Error)
	}
	bBefore, err := s.Store.readChatRun(b.ID, runB.ID)
	if err != nil || bBefore.Status != "running" {
		t.Fatal("cancel A stopped B", bBefore, err)
	}
	close(release)
	bResult := awaitRunTest(t, s, runB)
	if bResult.Status != "completed" {
		t.Fatal(bResult.Status, bResult.Error, jsonText(bResult.Events))
	}
	ah, _ := s.Store.chatHistory("doc", a.ID)
	bh, _ := s.Store.chatHistory("doc", b.ID)
	if len(ah) != 1 || len(bh) != 2 || !strings.Contains(bh[1].Content, "BETA") || bh[1].SessionID != b.ID {
		t.Fatal(ah, bh)
	}
	replay := request(t, s, "GET", "/api/documents/doc/chat-sessions/"+b.ID+"/runs/"+runB.ID+"/events", nil)
	if !strings.Contains(replay.Body.String(), "event: done") || !strings.Contains(replay.Body.String(), "BETA partial") {
		t.Fatal(replay.Body.String())
	}
	var state documentConversation
	var raw string
	if err = s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE provider=?", conversationProvider(b.ID, "api")).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(raw), &state)
	if len(state.PiEntries) == 0 {
		t.Fatal("pi continuation was not committed")
	}
}
func TestPiSaveFailureKeepsAcceptedState(t *testing.T) {
	piTestRuntime(t)
	s, _ := prepareConversationFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		writeConversationReply(w, "remember CIVET-42", "")
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	session := createSessionTest(t, s)
	first := awaitRunTest(t, s, startSessionTest(t, s, session, "CIVET-42"))
	if first.Status != "completed" {
		t.Fatal(first.Error)
	}
	var before, after string
	_ = s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE provider=?", conversationProvider(session.ID, "api")).Scan(&before)
	_, err := s.Store.DB.Exec(`CREATE TRIGGER fail_chat_save BEFORE INSERT ON messages WHEN json_extract(NEW.body,'$.role')='assistant' BEGIN SELECT RAISE(FAIL,'save blocked'); END;`)
	if err != nil {
		t.Fatal(err)
	}
	failed := awaitRunTest(t, s, startSessionTest(t, s, session, "next"))
	if failed.Status != "failed" {
		t.Fatal(failed.Status)
	}
	_ = s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE provider=?", conversationProvider(session.ID, "api")).Scan(&after)
	if before != after {
		t.Fatal("unsaved turn changed accepted state")
	}
	messages, _ := s.Store.chatHistory("doc", session.ID)
	if len(messages) != 3 {
		t.Fatal("partial assistant committed", messages)
	}
	for _, e := range failed.Events {
		if e.Event == "done" {
			t.Fatal("reported persisted success on save failure")
		}
	}
}

func TestPiReadingToolsAndAcceptedContinuation(t *testing.T) {
	piTestRuntime(t)
	s, _ := prepareConversationFixture(t)
	requests := 0
	toolRead := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		var payload struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []json.RawMessage       `json:"tools"`
		}
		if json.NewDecoder(r.Body).Decode(&payload) != nil {
			t.Error("invalid payload")
			return
		}
		requests++
		if len(payload.Tools) != 3 {
			t.Errorf("unexpected tools: %s", jsonText(payload.Tools))
		}
		if requests == 1 {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"read-1","type":"function","function":{"name":"read_passage","arguments":"{\"full\":true}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		for _, m := range payload.Messages {
			if m.Role == "tool" && strings.Contains(jsonText(m.Content), "COBALT-19") {
				toolRead = true
			}
		}
		if !toolRead {
			t.Error("host tool evidence missing")
		}
		writeConversationReply(w, "COBALT-19 [S2].", "private-continuation")
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	session := createSessionTest(t, s)
	first := awaitRunTest(t, s, startSessionTest(t, s, session, "Read COBALT-19"))
	if first.Status != "completed" {
		t.Fatal(first.Error, jsonText(first.Events))
	}
	// A fresh worker restores accepted native entries, including the tool pair.
	second := awaitRunTest(t, s, startSessionTest(t, s, session, "Continue"))
	if second.Status != "completed" {
		t.Fatal(second.Error, jsonText(second.Events))
	}
	if requests != 3 || !toolRead {
		t.Fatal(requests, toolRead)
	}
	messages, _ := s.Store.chatHistory("doc", session.ID)
	if len(messages) != 4 || !strings.Contains(string(messages[1].References), "corpusRevision") || messages[1].Reasoning != "private-continuation" {
		t.Fatal(messages)
	}
	if len(messages[1].Tools) != 1 || messages[1].Tools[0].Target == "read_passage" {
		t.Fatalf("lost actual reading target: %s", jsonText(messages[1].Tools))
	}
}

func TestRunConcurrencyLimitAndRestartReconciliation(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	fakePiConnection(t, s, "codex", "")
	session := createSessionTest(t, s)
	s.chatMu.Lock()
	s.chatRuns = map[string]*chatRun{}
	for i := 0; i < 4; i++ {
		s.chatRuns[fmt.Sprint(i)] = &chatRun{}
	}
	s.chatMu.Unlock()
	out := request(t, s, "POST", "/api/documents/doc/chat-sessions/"+session.ID+"/chat", strings.NewReader(`{"provider":"codex","prompt":"fifth","context":""}`))
	if out.Code != 429 {
		t.Fatal(out.Code, out.Body.String())
	}
	messages, _ := s.Store.chatHistory("doc", session.ID)
	if len(messages) != 0 {
		t.Fatal("rejected run saved a question")
	}
	s.chatMu.Lock()
	s.chatRuns = nil
	s.chatMu.Unlock()
	for i, status := range []string{"interrupted", "completed"} {
		question := Message{ID: id(), DocumentID: "doc", SessionID: session.ID, Role: "user", Content: fmt.Sprint(i)}
		if err := s.Store.saveMessage(question); err != nil {
			t.Fatal(err)
		}
		run := ChatRun{ID: id(), SessionID: session.ID, DocumentID: "doc", UserMessageID: question.ID, Status: "running"}
		_, err := s.Store.DB.Exec("INSERT INTO chat_runs VALUES(?,?,?)", run.ID, session.ID, jsonText(run))
		if err != nil {
			t.Fatal(err)
		}
		if status == "completed" {
			if err = s.Store.saveMessage(Message{DocumentID: "doc", SessionID: session.ID, Role: "assistant", Content: "committed before exit"}); err != nil {
				t.Fatal(err)
			}
		}
		store, err := OpenStore(s.Store.Root)
		if err != nil {
			t.Fatal(err)
		}
		restored, err := store.readChatRun(session.ID, run.ID)
		store.DB.Close()
		if err != nil || restored.Status != status {
			t.Fatal(restored, err)
		}
	}
}
