package neoread

import "testing"

func TestDeleteChatSessionRemovesTranscriptAndKeepsOthers(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	gone, kept := createSessionTest(t, s), createSessionTest(t, s)
	for _, m := range []Message{
		{ID: "gone-q", DocumentID: "doc", SessionID: gone.ID, Role: "user", Content: "q"},
		{ID: "gone-a", DocumentID: "doc", SessionID: gone.ID, Role: "assistant", Content: "a"},
		{ID: "kept-a", DocumentID: "doc", SessionID: kept.ID, Role: "assistant", Content: "a"},
	} {
		if err := s.Store.saveMessage(m); err != nil {
			t.Fatal(err)
		}
	}
	db := s.Store.DB
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO annotations VALUES(?,?,?)", []any{"note-gone", "doc", `{"id":"note-gone","text":"keep me","answerId":"gone-a"}`}},
		{"INSERT INTO annotations VALUES(?,?,?)", []any{"note-kept", "doc", `{"id":"note-kept","answerId":"kept-a"}`}},
		{"INSERT INTO chat_agent_runs VALUES(?,?,?)", []any{"agent-gone", "doc", `{"messageId":"gone-a"}`}},
		{"INSERT INTO chat_agent_runs VALUES(?,?,?)", []any{"agent-kept", "doc", `{"messageId":"kept-a"}`}},
		{"INSERT INTO chat_runs VALUES(?,?,?)", []any{"run-gone", gone.ID, `{}`}},
	} {
		if _, err := db.Exec(q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, sid := range []string{gone.ID, kept.ID} {
		if err := saveDocumentConversation(t.Context(), db, "doc", conversationProvider(sid, "codex"), documentConversation{ID: sid}); err != nil {
			t.Fatal(err)
		}
	}

	if out := request(t, s, "DELETE", "/api/documents/doc/chat-sessions/"+gone.ID, nil); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	count := func(sql string, args ...any) int {
		var n int
		if err := db.QueryRow(sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	checks := map[string]int{
		"SELECT count(*) FROM chat_sessions WHERE id='" + gone.ID + "'":                                                                          0,
		"SELECT count(*) FROM chat_sessions WHERE id='" + kept.ID + "'":                                                                          1,
		"SELECT count(*) FROM messages WHERE id IN ('gone-q','gone-a')":                                                                          0,
		"SELECT count(*) FROM messages WHERE id='kept-a'":                                                                                        1,
		"SELECT count(*) FROM chat_agent_runs WHERE id='agent-gone'":                                                                             0,
		"SELECT count(*) FROM chat_agent_runs WHERE id='agent-kept'":                                                                             1,
		"SELECT count(*) FROM chat_runs WHERE id='run-gone'":                                                                                     0,
		"SELECT count(*) FROM document_conversations WHERE provider LIKE 'session:" + gone.ID + ":%'":                                            0,
		"SELECT count(*) FROM document_conversations WHERE provider LIKE 'session:" + kept.ID + ":%'":                                            1,
		"SELECT count(*) FROM annotations WHERE id='note-gone' AND json_extract(body,'$.answerId')='' AND json_extract(body,'$.text')='keep me'": 1,
		"SELECT count(*) FROM annotations WHERE id='note-kept' AND json_extract(body,'$.answerId')='kept-a'":                                     1,
	}
	for q, want := range checks {
		if got := count(q); got != want {
			t.Errorf("%s = %d, want %d", q, got, want)
		}
	}
	if out := request(t, s, "DELETE", "/api/documents/doc/chat-sessions/"+gone.ID, nil); out.Code != 404 {
		t.Fatal("deleting twice", out.Code)
	}
}

func TestDeleteChatSessionRejectsActiveRun(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	session := createSessionTest(t, s)
	s.chatMu.Lock()
	if s.chatReservations == nil {
		s.chatReservations = map[string]bool{}
	}
	s.chatReservations[session.ID] = true
	s.chatMu.Unlock()
	if out := request(t, s, "DELETE", "/api/documents/doc/chat-sessions/"+session.ID, nil); out.Code != 409 {
		t.Fatal(out.Code, out.Body.String())
	}
	s.chatMu.Lock()
	delete(s.chatReservations, session.ID)
	s.chatMu.Unlock()
	if out := request(t, s, "DELETE", "/api/documents/doc/chat-sessions/"+session.ID, nil); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
}

func TestDeleteChatSessionRollsBackOnFailure(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	session := createSessionTest(t, s)
	if err := s.Store.saveMessage(Message{ID: "answer", DocumentID: "doc", SessionID: session.ID, Role: "assistant", Content: "preserved"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER block_session_delete BEFORE DELETE ON chat_sessions BEGIN SELECT RAISE(ABORT,'blocked'); END`); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "DELETE", "/api/documents/doc/chat-sessions/"+session.ID, nil); out.Code != 500 {
		t.Fatal(out.Code)
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE id='answer'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if _, err := s.Store.chatSession("doc", session.ID); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteChatSessionRequiresMatchingDocument(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	session := createSessionTest(t, s)
	if out := request(t, s, "DELETE", "/api/documents/other/chat-sessions/"+session.ID, nil); out.Code != 404 {
		t.Fatal(out.Code)
	}
	if _, err := s.Store.chatSession("doc", session.ID); err != nil {
		t.Fatal(err)
	}
}
