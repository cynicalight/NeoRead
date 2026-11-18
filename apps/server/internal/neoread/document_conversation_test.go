package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func prepareConversationFixture(t *testing.T) (*Server, *documentAgent) {
	t.Helper()
	s, a := originalDocumentFixture(t)
	d, _ := s.Store.Document("doc")
	if err := os.WriteFile(s.Store.File(d), []byte("original fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := s.documentCorpus(t.Context(), "doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	a.corpus = c
	return s, a
}
func conversationRequest(t *testing.T, s *Server, provider, prompt string) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(jsonText(map[string]any{"provider": provider, "prompt": prompt, "context": ""})))
}
func writeConversationReply(w http.ResponseWriter, text, continuation string) {
	w.Header().Set("Content-Type", "text/event-stream")
	data := map[string]any{"model": "deepseek-test", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text, "reasoning_content": continuation}, "finish_reason": "stop"}}}
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", jsonText(data))
}
func TestPiConversationPersistsAndRestarts(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	_, _ = s.Store.DB.Exec(`INSERT INTO settings VALUES('neoread','{"documentContextTokens":8192}')`)
	answerCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]any{"id": "test", "context_window": 8192}}})
			return
		}
		var payload struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
		}
		if json.NewDecoder(r.Body).Decode(&payload) != nil {
			t.Error("invalid request")
			return
		}
		answerCalls++
		if len(payload.Tools) == 0 {
			t.Error("unexpected separate final-answer request")
		}
		if !strings.Contains(jsonText(payload.Messages), "CIVET-42") {
			t.Errorf("turn %d forgot first-turn context", answerCalls)
		}
		for _, m := range payload.Messages {
			if m.Role == "assistant" && m.Reasoning != "private-continuation" {
				t.Error("provider continuation lost across questions")
			}
		}
		writeConversationReply(w, "CIVET-42 "+strings.Repeat("这是已经解释过的内容。", 90), "private-continuation")
	}))
	defer server.Close()
	configureDocumentAPI(t, s, server.URL)
	for i := 0; i < 5; i++ {
		question := fmt.Sprintf("继续说明第 %d 点", i)
		if i == 0 {
			question = "请记住 CIVET-42，后面都用中文解释。"
		}
		out := conversationRequest(t, s, "api", question)
		if strings.Count(out.Body.String(), "event: done") != 1 {
			t.Fatalf("turn %d: %s", i, out.Body.String())
		}
		if !strings.Contains(out.Body.String(), "event: reasoning") {
			t.Fatal("provider thinking missing from its separate UI channel")
		}
		if i == 2 {
			s.Close()
			s = NewServer(s.Store, "test-secret", "")
			t.Cleanup(s.Close)
		}
	}
	if answerCalls != 5 {
		t.Fatal("missing single-loop replies", answerCalls)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 10 || !strings.Contains(history[0].Content, "CIVET-42") {
		t.Fatal("fixed history clipping remains", len(history), err)
	}
	var raw string
	if err = s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE document_id='doc' AND provider='api'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var state documentConversation
	_ = json.Unmarshal([]byte(raw), &state)
	if state.LastMessageID != history[len(history)-1].ID || !strings.Contains(string(state.PiEntries), "private-continuation") {
		t.Fatal("Pi window not durably saved")
	}
}

func TestConversationCompactionKeepsProtocolGroups(t *testing.T) {
	call := completionToolCall{ID: "call", Type: "function"}
	call.Function.Name = "read_passage"
	paired := []toolCompletionMessage{{Role: "user", Content: "question"}, {Role: "assistant", Calls: []completionToolCall{call}, Reasoning: "private"}, {Role: "tool", CallID: "call", Content: "original"}, {Role: "assistant", Content: "answer"}}
	groups, err := conversationGroups(paired)
	if err != nil || len(groups) != 3 || len(groups[1]) != 2 {
		t.Fatal("tool pair was split", groups, err)
	}
	if _, err = conversationGroups(paired[:2]); err == nil {
		t.Fatal("compacted unfinished tool call")
	}
	if _, err = conversationGroups(paired[2:]); err == nil {
		t.Fatal("accepted orphan tool result")
	}
	text := strings.Repeat("中文⚡source", 3000)
	left := text
	var all strings.Builder
	for left != "" {
		part, rest := takeCompactionText(left, 500)
		if part == "" || estimateDocumentTokens(part) > 500 {
			t.Fatal("invalid compaction fragment")
		}
		all.WriteString(part)
		left = rest
	}
	if all.String() != text {
		t.Fatal("compaction input lost original data")
	}
}
func TestFailedAPITurnDoesNotReplaceConversation(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		calls++
		if calls == 2 {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")
			return
		}
		writeConversationReply(w, "remembered", "private")
	}))
	defer server.Close()
	configureDocumentAPI(t, s, server.URL)
	if out := conversationRequest(t, s, "api", "remember this"); !strings.Contains(out.Body.String(), "event: done") {
		t.Fatal(out.Body.String())
	}
	var before, after string
	_ = s.Store.DB.QueryRow("SELECT body FROM document_conversations").Scan(&before)
	out := conversationRequest(t, s, "api", "fail this time")
	if strings.Contains(out.Body.String(), "event: done") || !strings.Contains(out.Body.String(), "event: draft") {
		t.Fatal("partial turn incorrectly completed", out.Body.String())
	}
	_ = s.Store.DB.QueryRow("SELECT body FROM document_conversations").Scan(&after)
	if before != after {
		t.Fatal("failed turn replaced the committed context")
	}
}

func TestConversationContextDeltaAndRevision(t *testing.T) {
	s, a := originalDocumentFixture(t)
	a.provider = "api"
	state := documentConversation{ID: id(), ConnectionKey: "key", Revision: a.corpus.Revision, PassageCount: len(a.corpus.Passages), SeenSources: map[string]bool{"existing": true}}
	if err := saveDocumentConversation(t.Context(), s.Store.DB, "doc", "api", state); err != nil {
		t.Fatal(err)
	}
	input := AIInput{Prompt: "question", Chat: &chatInput{Question: "question", CurrentText: "unchanged source", Agent: a}}
	if err := a.prepareReading(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if _, err := a.beginConversation(t.Context(), input, "key"); err != nil {
		t.Fatal(err)
	}
	first := a.conversationInput(input, false)
	next := a.conversationInput(input, false)
	if !strings.Contains(first, "unchanged source") || strings.Contains(next, "unchanged source") {
		t.Fatal("same source resent every question", next)
	}
	if a.committedConversation.SeenSources[sourceKey("unchanged source")] {
		t.Fatal("uncommitted source changed durable checkpoint")
	}
	a.corpus.Revision = "new-source-version"
	if _, err := a.beginConversation(t.Context(), input, "key"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(a.conversationInput(input, false), "new-source-version") || a.conversation.SourceOffset != state.PassageCount {
		t.Fatal("source update silently reused old context/IDs")
	}
}

func TestConversationCitationsSurviveModelAndProviderChanges(t *testing.T) {
	for _, provider := range []string{"api", "claude"} {
		t.Run(provider, func(t *testing.T) {
			s, first := originalDocumentFixture(t)
			first.provider = "api"
			input := AIInput{Chat: &chatInput{Question: "explain", Agent: first}}
			if _, err := first.beginConversation(t.Context(), input, "first-model"); err != nil {
				t.Fatal(err)
			}
			if _, err := first.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`)); err != nil {
				t.Fatal(err)
			}
			source := first.Evidence[0]
			answer := "Original explanation [" + source.SourceID + "]"
			if err := s.saveDocumentAgentAnswer(t.Context(), first, answer, "api"); err != nil {
				t.Fatal(err)
			}
			history, err := s.Store.chatHistory("doc")
			if err != nil {
				t.Fatal(err)
			}
			next := &documentAgent{server: s, corpus: first.corpus, ctx: t.Context(), provider: provider}
			input.Chat.Agent, input.Chat.History = next, history
			missed, err := next.beginConversation(t.Context(), input, "second-model")
			if err != nil {
				t.Fatal(err)
			}
			if len(missed) != 1 || len(next.conversation.PiEntries) != 0 {
				t.Fatal("model-specific continuation was reused or visible history lost", missed)
			}
			if err := s.saveDocumentAgentAnswer(t.Context(), next, "Follow-up ["+source.SourceID+"]", provider); err != nil {
				t.Fatal(err)
			}
			history, err = s.Store.chatHistory("doc")
			if err != nil {
				t.Fatal(err)
			}
			message := history[len(history)-1]
			var refs []documentEvidence
			if err := json.Unmarshal(message.References, &refs); err != nil || len(refs) != 1 || refs[0].SourceID != source.SourceID || refs[0].BlockID != source.BlockID {
				t.Fatalf("model switch lost the saved source: %s %v", message.References, err)
			}
			if out := request(t, s, "GET", "/api/documents/doc/messages/"+message.ID+"/sources/"+source.SourceID, nil); out.Code != 200 {
				t.Fatal("follow-up citation cannot navigate", out.Code, out.Body.String())
			}
			if len(next.Evidence) != 0 || len(next.turnRead) != 0 {
				t.Fatal("historical citations were counted as a new original-text read")
			}
		})
	}
}

func TestHistoricalCitationsValidateChatScopeAndOriginalContent(t *testing.T) {
	for _, scenario := range []string{"valid", "legacy", "old revision", "different document", "different session", "user message", "unknown block", "altered text", "wrong hash"} {
		t.Run(scenario, func(t *testing.T) {
			_, a := originalDocumentFixture(t)
			a.provider, a.sessionID = "claude", "current-session"
			ev := a.passageEvidence(0)
			message := Message{ID: "previous-answer", Role: "assistant", DocumentID: "doc", SessionID: a.sessionID}
			switch scenario {
			case "legacy":
				ev.BlockID = ""
			case "old revision":
				ev.Revision = "old"
			case "different document":
				message.DocumentID = "another-document"
			case "different session":
				message.SessionID = "another-session"
			case "user message":
				message.Role = "user"
			case "unknown block":
				ev.BlockID = "unreturned-999"
			case "altered text":
				ev.Text = "not the original"
				ev.Hash = sourceKey(ev.Text)
			case "wrong hash":
				ev.Hash = "wrong"
			}
			message.References = json.RawMessage(jsonText([]documentEvidence{ev}))
			input := AIInput{Chat: &chatInput{Agent: a, History: []Message{message}}}
			if _, err := a.beginConversation(t.Context(), input, "new-model"); err != nil {
				t.Fatal(err)
			}
			refs, err := a.references("Answer [" + ev.SourceID + "]")
			var parsed []documentEvidence
			if err != nil || json.Unmarshal(refs, &parsed) != nil {
				t.Fatal(string(refs), err)
			}
			want := 0
			if scenario == "valid" || scenario == "legacy" {
				want = 1
			}
			if len(parsed) != want {
				t.Fatalf("unsafe or lost historical citation: %s", refs)
			}
			coverage := a.readingCoverage().(map[string]any)
			if coverage["readPassages"] != 0 || len(a.Evidence) != 0 {
				t.Fatal("historical citation inflated reading coverage", coverage)
			}
		})
	}
}

func TestHistoricalSourceLabelConflictsDoNotGuessTargets(t *testing.T) {
	_, a := originalDocumentFixture(t)
	first, second := a.passageEvidence(0), a.passageEvidence(1)
	second.SourceID = first.SourceID
	message := Message{Role: "assistant", DocumentID: "doc", References: json.RawMessage(jsonText([]documentEvidence{first, second}))}
	a.restoreHistoricalEvidence([]Message{message})
	if refs, err := a.references("[" + first.SourceID + "]"); err != nil || string(refs) != "[]" {
		t.Fatalf("ambiguous historical label acquired a target: %s %v", refs, err)
	}
	refs, err := a.references("[" + first.BlockID + "][" + second.BlockID + "]")
	var parsed []documentEvidence
	if err != nil || json.Unmarshal(refs, &parsed) != nil || len(parsed) != 2 {
		t.Fatalf("unambiguous block citations were lost: %s %v", refs, err)
	}
}
