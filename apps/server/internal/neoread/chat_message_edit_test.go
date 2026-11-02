package neoread

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func chatEditFixture(t *testing.T) (*Server, ChatSession, ChatSession, []Message) {
	t.Helper()
	s, _ := prepareConversationFixture(t)
	a, b := createSessionTest(t, s), createSessionTest(t, s)
	var history []Message
	for i, key := range []string{"first", "middle", "last"} {
		user := Message{ID: key + "-user", DocumentID: "doc", SessionID: a.ID, Role: "user", Content: key, CreatedAt: "2021-02-03T04:05:06Z", Context: "original context", WebSearch: true,
			References: json.RawMessage(`[{"text":"原文 $H'$","location":{"type":"pdf","page":2},"kind":"selection"}]`), ReadingLocation: json.RawMessage(`{"type":"pdf","page":2}`), Attachments: []ImageAttachment{{ID: "p2-b1", Page: 2, Label: "chart", Caption: "原图"}}}
		answer := Message{ID: key + "-answer", DocumentID: "doc", SessionID: a.ID, Role: "assistant", Content: "answer " + key, Reasoning: "thinking", CreatedAt: user.CreatedAt}
		for _, m := range []Message{user, answer} {
			if _, err := s.Store.DB.Exec("INSERT INTO messages VALUES(?,?,?,?)", m.ID, m.DocumentID, jsonText(m), m.CreatedAt); err != nil {
				t.Fatal(err)
			}
			history = append(history, m)
		}
		if i == 1 {
			for _, role := range []string{"user", "assistant"} {
				m := Message{ID: "other-" + role, DocumentID: "doc", SessionID: b.ID, Role: role, Content: "other session", CreatedAt: user.CreatedAt}
				if _, err := s.Store.DB.Exec("INSERT INTO messages VALUES(?,?,?,?)", m.ID, m.DocumentID, jsonText(m), m.CreatedAt); err != nil {
					t.Fatal(err)
				}
			}
		}
		run := chatRunRecord{ChatRun: ChatRun{ID: key + "-run", SessionID: a.ID, DocumentID: "doc", UserMessageID: user.ID, Status: "completed", Provider: "api", StartedAt: user.CreatedAt, FinishedAt: user.CreatedAt}, Events: []chatRunEvent{{Event: "done", Data: json.RawMessage(`{"ok":true}`)}}}
		if _, err := s.Store.DB.Exec("INSERT INTO chat_runs VALUES(?,?,?)", run.ID, a.ID, jsonText(run)); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Exec("INSERT INTO chat_agent_runs VALUES(?,?,?)", key+"-evidence", "doc", jsonText(map[string]any{"messageId": answer.ID, "evidence": []string{"source"}})); err != nil {
			t.Fatal(err)
		}
	}
	for _, session := range []string{a.ID, b.ID, a.ID + "suffix"} {
		for _, provider := range []string{"api", "codex", "claude", "kimi"} {
			if err := saveDocumentConversation(t.Context(), s.Store.DB, "doc", conversationProvider(session, provider), documentConversation{ID: session + provider, ConnectionKey: "key", LastMessageID: "last-answer", NativeThread: "old-thread"}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for key, answer := range map[string]string{"linked": "middle-answer", "other": "other-assistant"} {
		annotation := Annotation{ID: key, DocumentID: "doc", Kind: "question", Note: "keep my note", AnswerID: answer, Resolved: true, Quote: "keep my quote", Location: json.RawMessage(`{"type":"pdf","page":2}`)}
		if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", key, "doc", jsonText(annotation)); err != nil {
			t.Fatal(err)
		}
	}
	return s, a, b, history
}

func changeQuestionTest(t *testing.T, s *Server, session, message, method string, change chatMessageChange) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, s, method, "/api/documents/doc/chat-sessions/"+session+"/messages/"+message, strings.NewReader(jsonText(change)))
}

func TestEditAndWithdrawChatQuestionPreservesContextAndOtherSessions(t *testing.T) {
	s, a, b, before := chatEditFixture(t)
	otherBefore, _ := s.Store.chatHistory("doc", b.ID)
	content := "编辑后的问题 $H'$"
	out := changeQuestionTest(t, s, a.ID, "middle-user", "PATCH", chatMessageChange{ExpectedLastMessageID: "last-answer", ExpectedContent: "middle", Content: &content})
	if out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	var result chatMessageChangeResult
	if err := json.Unmarshal(out.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	expected := before[2]
	expected.Content = content
	if !reflect.DeepEqual(result.Message, expected) || !reflect.DeepEqual(result.Messages, []Message{before[0], before[1], expected}) {
		t.Fatalf("edited question lost source context or original date: %+v", result)
	}
	other, _ := s.Store.chatHistory("doc", b.ID)
	if !reflect.DeepEqual(otherBefore, other) {
		t.Fatal("another session changed", other)
	}
	for table, want := range map[string]int{"chat_runs": 1, "chat_agent_runs": 1, "document_conversations": 8} {
		var count int
		if err := s.Store.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != want {
			t.Fatalf("%s: %d want %d: %v", table, count, want, err)
		}
	}
	var raw string
	if err := s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id='linked'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var mark Annotation
	_ = json.Unmarshal([]byte(raw), &mark)
	if mark.AnswerID != "" || mark.Resolved || mark.Note != "keep my note" || mark.Quote != "keep my quote" {
		t.Fatal("annotation content lost or stale answer retained", mark)
	}
	_ = s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id='other'").Scan(&raw)
	_ = json.Unmarshal([]byte(raw), &mark)
	if mark.AnswerID != "other-assistant" || !mark.Resolved {
		t.Fatal("another session's annotation changed", mark)
	}
	state, err := s.Store.documentConversation(t.Context(), "doc", conversationProvider(a.ID, "codex"), "key")
	if err != nil || state.NativeThread != "" || state.LastMessageID != "" {
		t.Fatal("old provider continuation survived edit", state, err)
	}
	withdrawn := changeQuestionTest(t, s, a.ID, "middle-user", "DELETE", chatMessageChange{ExpectedLastMessageID: "middle-user", ExpectedContent: content})
	if withdrawn.Code != 200 {
		t.Fatal(withdrawn.Code, withdrawn.Body.String())
	}
	var returned chatMessageChangeResult
	if err := json.Unmarshal(withdrawn.Body.Bytes(), &returned); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(returned.Message, expected) || !reflect.DeepEqual(returned.Messages, before[:2]) {
		t.Fatal("withdraw lost question context or retained stale history", returned)
	}
	result.Messages = returned.Messages
	// Reloading the database retains the edited/withdrawn transcript.

	s.Store.DB.Close()
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	got, err := reopened.chatHistory("doc", a.ID)
	if err != nil || !reflect.DeepEqual(result.Messages, got) {
		t.Fatal("edit did not persist", got, err)
	}
}

func TestChatQuestionChangeRollsBackTranscriptAndSourcesOnSaveFailure(t *testing.T) {
	s, a, _, before := chatEditFixture(t)
	if _, err := s.Store.DB.Exec("CREATE TRIGGER reject_chat_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'test save failure'); END"); err != nil {
		t.Fatal(err)
	}
	content := "new question"
	out := changeQuestionTest(t, s, a.ID, "middle-user", "PATCH", chatMessageChange{ExpectedLastMessageID: "last-answer", ExpectedContent: "middle", Content: &content})
	if out.Code != 500 {
		t.Fatal(out.Code, out.Body.String())
	}
	got, _ := s.Store.chatHistory("doc", a.ID)
	if !reflect.DeepEqual(before, got) {
		t.Fatal("failed transaction changed messages")
	}
	var count int
	for table, want := range map[string]int{"chat_runs": 3, "chat_agent_runs": 3, "document_conversations": 12} {
		if err := s.Store.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != want {
			t.Fatal("failed transaction lost records", table, count, err)
		}
	}
	var raw string
	_ = s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id='linked'").Scan(&raw)
	if !strings.Contains(raw, `"answerId":"middle-answer"`) {
		t.Fatal("failed transaction changed annotations", raw)
	}
}
