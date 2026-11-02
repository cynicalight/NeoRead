package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Compare persisted business records, including ordering and original timestamps.
// Imported Codex continuations are deliberately rebuilt from these transcripts.
func chatArchiveSnapshot(t *testing.T, store *Store) map[string][]string {
	t.Helper()
	queries := map[string]string{
		"sessions":      "SELECT json_array(id,document_id,title,provider,created_at,updated_at) FROM chat_sessions WHERE document_id='doc' ORDER BY rowid",
		"messages":      "SELECT json_array(id,body,created_at) FROM messages WHERE document_id='doc' ORDER BY rowid",
		"runs":          "SELECT json_array(id,body) FROM chat_runs WHERE session_id IN (SELECT id FROM chat_sessions WHERE document_id='doc') ORDER BY rowid",
		"evidence":      "SELECT json_array(id,body) FROM chat_agent_runs WHERE document_id='doc' ORDER BY rowid",
		"annotations":   "SELECT body FROM annotations WHERE document_id='doc' ORDER BY rowid",
		"continuations": "SELECT json_array(provider,body) FROM document_conversations WHERE document_id='doc' AND provider!='codex' AND substr(provider,-6)!=':codex' ORDER BY provider",
	}
	result := map[string][]string{}
	for name, query := range queries {
		rows, err := store.DB.Query(query)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var raw string
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if name == "annotations" {
				// OpenStore normalizes empty optional annotation fields.
				var annotation Annotation
				if err := json.Unmarshal([]byte(raw), &annotation); err != nil {
					t.Fatal(err)
				}
				raw = jsonText(annotation)
			}
			result[name] = append(result[name], raw)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
	}
	return result
}

func TestChatArchiveCodexRebuildsHistoryAndEditsForgetRemovedTurns(t *testing.T) {
	s, agent := prepareConversationFixture(t)
	fakeAgent(t, "codex", "document-conversation")
	capture := filepath.Join(t.TempDir(), "capture.jsonl")
	t.Setenv("NEOREAD_CONVERSATION_CAPTURE", capture)
	t.Setenv("NEOREAD_DOCUMENT_TEST_BLOCK", agent.corpus.Passages[1].ID)
	a, b := createSessionTest(t, s), createSessionTest(t, s)
	start := func(server *Server, session ChatSession, prompt, userID string) {
		t.Helper()
		out := request(t, server, "POST", "/api/documents/doc/chat-sessions/"+session.ID+"/chat", strings.NewReader(jsonText(map[string]any{"provider": "codex", "prompt": prompt, "context": "", "userMessageId": userID})))
		if out.Code != 202 {
			t.Fatal(out.Code, out.Body.String())
		}
		var run ChatRun
		_ = json.Unmarshal(out.Body.Bytes(), &run)
		if record := awaitRunTest(t, server, run); record.Status != "completed" {
			t.Fatal(record.Error)
		}
	}
	start(s, a, "记住 CIVET-42", id())
	start(s, b, "记住 CIVET-42", id())
	s.Close()
	server := NewServer(s.Store, "test-secret", "")
	t.Cleanup(server.Close)
	history, _ := s.Store.chatHistory("doc", a.ID)
	content := "换成一个新问题"
	if out := changeQuestionTest(t, server, a.ID, history[0].ID, "PATCH", chatMessageChange{ExpectedLastMessageID: history[1].ID, ExpectedContent: history[0].Content, Content: &content}); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	start(server, a, content, history[0].ID)
	history, _ = server.Store.chatHistory("doc", a.ID)
	if len(history) != 2 || strings.Contains(history[1].Content, "CIVET-42") {
		t.Fatal("edited question retained the removed provider context", history)
	}
	before, _ := server.Store.chatHistory("doc", b.ID)
	server.Close()
	server.Store.DB.Close()
	parent := t.TempDir()
	archivePath, restoredPath := filepath.Join(parent, "codex.zip"), filepath.Join(parent, "restored")
	if err := ExportLibraryArchive(server.Store.Root, archivePath, LibraryArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := ImportLibraryArchive(archivePath, restoredPath, ""); err != nil {
		t.Fatal(err)
	}
	restored := NewServer(archiveFixture(t, restoredPath), "test-secret", "")
	t.Cleanup(restored.Close)
	start(restored, b, "继续解释", id())
	after, err := restored.Store.chatHistory("doc", b.ID)
	if err != nil || len(after) != 4 || !reflect.DeepEqual(before, after[:2]) || !strings.Contains(after[3].Content, "CIVET-42") {
		t.Fatal("imported Codex session failed to continue from the saved transcript", after, err)
	}
	data, err := os.ReadFile(capture)
	if err != nil || strings.Contains(string(data), `"method":"thread/resume"`) || strings.Count(string(data), `"method":"thread/start"`) != 4 {
		t.Fatal("import or edit reused the original native thread", string(data), err)
	}
}

func TestChatSessionsPersistAndMigrateAfterEditsAndWithdrawals(t *testing.T) {
	s, a, b, _ := chatEditFixture(t)
	if _, err := s.Store.DB.Exec("UPDATE chat_sessions SET title=CASE id WHEN ? THEN '公式讨论' WHEN ? THEN '方法讨论' ELSE title END,provider=CASE id WHEN ? THEN 'codex' ELSE provider END", a.ID, b.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	// The retained second session has a completed run, tool use, web sources and
	// linked answer evidence as well as the first session's source/image context.
	var answer Message
	var raw string
	if err := s.Store.DB.QueryRow("SELECT body FROM messages WHERE id='other-assistant'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(raw), &answer)
	answer.Reasoning = "保留的思考记录"
	answer.References = json.RawMessage(`[{"text":"原文证据","location":{"type":"pdf","page":2},"sourceId":"S1","contentHash":"source-hash","corpusRevision":"revision"}]`)
	answer.Tools = []ToolActivity{{ID: "tool", Kind: "tool", Tool: "read_passage", Title: "读取原文", Status: "completed", StartedAt: answer.CreatedAt, FinishedAt: answer.CreatedAt}}
	answer.WebSources = []WebSource{{ID: "W1", URL: "https://example.com/source", Title: "参考来源", Text: "来源摘录", Kind: "page", RetrievedAt: "2021-02-03T04:05:06Z"}}
	if _, err := s.Store.DB.Exec("UPDATE messages SET body=? WHERE id=?", jsonText(answer), answer.ID); err != nil {
		t.Fatal(err)
	}
	run := chatRunRecord{ChatRun: ChatRun{ID: "other-run", SessionID: b.ID, DocumentID: "doc", UserMessageID: "other-user", Provider: "codex", Status: "completed", StartedAt: answer.CreatedAt, FinishedAt: answer.CreatedAt}, Events: []chatRunEvent{{Event: "delta", Data: json.RawMessage(`{"text":"other session"}`)}, {Event: "done", Data: json.RawMessage(`{"ok":true}`)}}}
	if _, err := s.Store.DB.Exec("INSERT INTO chat_runs VALUES(?,?,?)", run.ID, b.ID, jsonText(run)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("INSERT INTO chat_agent_runs VALUES(?,?,?)", "other-evidence", "doc", jsonText(map[string]any{"messageId": answer.ID, "tools": answer.Tools, "evidence": json.RawMessage(answer.References), "status": "complete"})); err != nil {
		t.Fatal(err)
	}
	asset := filepath.Join("cache", "doc", "analysis", "assets", "p2-b1.png")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(s.Store.Root, asset)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Store.Root, asset), []byte("original attachment pixels"), 0600); err != nil {
		t.Fatal(err)
	}
	if out := changeQuestionTest(t, s, a.ID, "last-user", "DELETE", chatMessageChange{ExpectedLastMessageID: "last-answer", ExpectedContent: "last"}); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	content := "编辑后的保留问题 $H'$"
	if out := changeQuestionTest(t, s, a.ID, "middle-user", "PATCH", chatMessageChange{ExpectedLastMessageID: "middle-answer", ExpectedContent: "middle", Content: &content}); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	want := chatArchiveSnapshot(t, s.Store)
	if len(want["sessions"]) != 3 || len(want["messages"]) != 5 || len(want["runs"]) != 2 || len(want["evidence"]) != 2 {
		t.Fatal("fixture did not exercise multiple persisted sessions", want)
	}
	s.Store.DB.Close()
	reopened := archiveFixture(t, s.Store.Root)
	if got := chatArchiveSnapshot(t, reopened); !reflect.DeepEqual(want, got) {
		t.Fatal("chat records changed after reopening the library", got)
	}
	reopened.DB.Close()
	parent := t.TempDir()
	archivePath := filepath.Join(parent, "聊天书库.zip")
	if err := ExportLibraryArchive(s.Store.Root, archivePath, LibraryArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"new", "merge"} {
		t.Run(mode, func(t *testing.T) {
			mergeRoot := ""
			if mode == "merge" {
				current := archiveFixture(t, filepath.Join(parent, "existing"))
				archiveDocument(t, current, "existing", "旧分类")
				archiveDocument(t, current, "doc", "旧文档版本")
				if _, err := current.DB.Exec("INSERT INTO chat_sessions VALUES('obsolete-session','doc','被替换的旧会话','api','old','old')"); err != nil {
					t.Fatal(err)
				}
				current.DB.Close()
				mergeRoot = current.Root
			}
			destination := filepath.Join(parent, mode)
			if err := ImportLibraryArchive(archivePath, destination, mergeRoot); err != nil {
				t.Fatal(err)
			}
			restored := archiveFixture(t, destination)
			got := chatArchiveSnapshot(t, restored)
			for table, expected := range want {
				if !reflect.DeepEqual(expected, got[table]) {
					t.Fatalf("%s changed during %s ZIP restore:\nwant %v\ngot %v", table, mode, expected, got[table])
				}
			}
			var count int
			if err := restored.DB.QueryRow("SELECT count(*) FROM document_conversations WHERE provider='codex' OR substr(provider,-6)=':codex'").Scan(&count); err != nil || count != 0 {
				t.Fatal("import retained a machine-bound Codex thread", count, err)
			}
			messages, err := restored.chatHistory("doc", a.ID)
			if err != nil || len(messages) != 3 || messages[2].Content != content || len(messages[2].Attachments) != 1 || len(messages[2].References) == 0 || string(messages[2].ReadingLocation) != `{"type":"pdf","page":2}` {
				t.Fatal("edited question lost its context", messages, err)
			}
			image, err := os.ReadFile(filepath.Join(destination, asset))
			if err != nil || string(image) != "original attachment pixels" {
				t.Fatal("chat image attachment lost", err)
			}
			if mode == "merge" {
				if _, err := restored.Document("existing"); err != nil {
					t.Fatal("merge lost an existing document", err)
				}
			}
		})
	}
}
