package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLibraryArchivePhysicallyRemovesExcludedDatabaseData(t *testing.T) {
	parent := t.TempDir()
	source := archiveFixture(t, filepath.Join(parent, "source"))
	archiveDocument(t, source, "included", "selected")
	archiveDocument(t, source, "excluded", "other")
	const secret = "archiveprivatekeycanary123456789"
	const excluded = "archiveexcludedtextcanary987654321"
	const included = "archiveincludedtextcanary246813579"
	if _, err := source.DB.Exec(`PRAGMA secure_delete=OFF; INSERT INTO settings VALUES('journal-rank:key',?)`, secret); err != nil {
		t.Fatal(err)
	}
	for _, table := range archiveFTSTables {
		if _, err := source.DB.Exec("UPDATE "+table+" SET content=? WHERE document_id='excluded'", excluded); err != nil {
			t.Fatal(err)
		}
		if _, err := source.DB.Exec("UPDATE "+table+" SET content=? WHERE document_id='included'", included); err != nil {
			t.Fatal(err)
		}
	}
	// The overview FTS has no fixture rows yet.
	if _, err := source.DB.Exec(`INSERT INTO document_overviews_fts VALUES('excluded','revision',?),('included','revision',?)`, excluded, included); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []LibraryArchiveOptions{{}, {Library: "papers", Folder: "selected"}} {
		t.Run("folder="+scope.Folder, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "library.zip")
			if err := ExportLibraryArchive(source.Root, path, scope); err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(t.TempDir(), "extracted")
			if _, err := extractLibraryArchive(context.Background(), path, destination); err != nil {
				t.Fatal(err)
			}
			body, err := os.ReadFile(filepath.Join(destination, "neoread.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(body, []byte(secret)) {
				t.Error("excluded key remains in exported database bytes")
			}
			if scope.Folder != "" && bytes.Contains(body, []byte(excluded)) {
				t.Error("excluded document remains in exported database bytes")
			}
			restored := archiveFixture(t, destination)
			for _, table := range archiveFTSTables {
				var count int
				if err := restored.DB.QueryRow("SELECT count(*) FROM "+table+" WHERE "+table+" MATCH ?", included).Scan(&count); err != nil || count != 1 {
					t.Fatalf("included search content lost from %s: %d %v", table, count, err)
				}
			}
		})
	}
}

func archiveFixture(t *testing.T, root string) *Store {
	t.Helper()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	return store
}
func archiveDocument(t *testing.T, store *Store, id, folder string) {
	t.Helper()
	folders, _ := json.Marshal([]string{folder})
	if _, err := store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,folders,library) VALUES(?,'pdf',?,'作者',8,'2026-11-02','2026-11-02',?,'papers')`, id, id, string(folders)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root, "papers", id+".pdf"), []byte("PDF "+id), 0600); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(store.Root, "cache", id, "analysis")
	if err := os.MkdirAll(cache, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "manifest.json"), []byte(`{"blocks":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "figure.png"), []byte("original figure "+id), 0600); err != nil {
		t.Fatal(err)
	}
	fingerprint, err := (&Server{Store: store}).corpusFingerprint(Document{ID: id, Type: "pdf"})
	if err != nil {
		t.Fatal(err)
	}
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO annotations VALUES(?,?,?)`, []any{"annotation-" + id, id, `{"id":"annotation-` + id + `","documentId":"` + id + `","kind":"highlight","note":"注释","location":{"type":"pdf","page":1}}`}},
		{`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,'formula','hash','complete',?)`, []any{id, `{"blockId":"formula","sourceHash":"hash","status":"complete","sentences":[],"formulaMarkdown":"$$x=1$$"}`}},
		{`INSERT INTO document_notes VALUES(?,?,?)`, []any{id, "# 笔记\n原样保存", "2026-11-02"}},
		{`INSERT INTO messages VALUES(?,?,?,?)`, []any{"message-" + id, id, `{"role":"assistant","content":"回答"}`, "2026-11-02"}},
		{`INSERT INTO document_corpora VALUES(?,?,?,?)`, []any{id, fingerprint, "revision", `{"passages":[]}`}},
		{`INSERT INTO search_index VALUES(?,'chapter','original text')`, []any{id}},
		{`INSERT INTO document_passages_fts VALUES(?,'revision','block','searchable passage')`, []any{id}},
	}
	for _, statement := range statements {
		if _, err := store.DB.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLibraryArchiveRoundTripAndCategory(t *testing.T) {
	parent := t.TempDir()
	source := archiveFixture(t, filepath.Join(parent, "source"))
	archiveDocument(t, source, "a", "研究/语言")
	archiveDocument(t, source, "b", "其他")
	if _, err := source.DB.Exec("UPDATE documents SET created_at='2020-03-04T05:06:07Z' WHERE id='a'; UPDATE documents SET created_at='2024-08-09T10:11:12.123Z' WHERE id='b'"); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("attachment"))
	attachment := hex.EncodeToString(hash[:])
	if err := os.WriteFile(filepath.Join(source.Root, "attachments", attachment), []byte("attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := source.DB.Exec(`INSERT INTO paper_attachments(id,document_id,kind,title,sha256,created_at) VALUES('attachment','a','file','附件',?,'now')`, attachment); err != nil {
		t.Fatal(err)
	}
	if _, err := source.DB.Exec(`INSERT INTO settings VALUES('preferences:library','{"papers":{"categories":["研究","研究/语言","其他"]}}'),('api:key','PRIVATE_KEY'),('neoread','{"documentTabs":true}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := source.DB.Exec("INSERT INTO settings VALUES(?,?)", epubMetadataMigration, "already-migrated"); err != nil {
		t.Fatal(err)
	}
	if _, err := source.DB.Exec(`UPDATE documents SET tags='["AI"]' WHERE id='a'; UPDATE settings SET value=json_set(value,'$.papers.smartCategories',json('[{"id":"smart-ai","name":"AI","tags":["ai"]}]')) WHERE key='preferences:library'`); err != nil {
		t.Fatal(err)
	}
	source.DB.Close()
	for _, scope := range []LibraryArchiveOptions{{}, {Library: "papers", Folder: "研究"}, {Library: "papers", SmartCategory: "smart-ai"}} {
		name := "all"
		expected := 2
		if scope.Folder != "" {
			name = "category"
			expected = 1
		}
		if scope.SmartCategory != "" {
			name = "smart"
			expected = 1
		}
		archivePath := filepath.Join(parent, name+".zip")
		if err := ExportLibraryArchive(source.Root, archivePath, scope); err != nil {
			t.Fatal(err)
		}
		destination := filepath.Join(parent, name)
		if err := ImportLibraryArchive(archivePath, destination, ""); err != nil {
			t.Fatal(err)
		}
		restored := archiveFixture(t, destination)
		var count int
		if err := restored.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count); err != nil || count != expected {
			t.Fatalf("documents: %d %v", count, err)
		}
		for _, table := range []string{"annotations", "translations", "document_notes", "messages", "document_corpora", "search_index", "document_passages_fts"} {
			if err := restored.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != expected {
				t.Fatalf("%s: %d %v", table, count, err)
			}
		}
		var body string
		for id, date := range map[string]string{"a": "2020-03-04T05:06:07Z", "b": "2024-08-09T10:11:12.123Z"} {
			if id == "b" && expected == 1 {
				continue
			}
			var added string
			if err := restored.DB.QueryRow("SELECT created_at FROM documents WHERE id=?", id).Scan(&added); err != nil || added != date {
				t.Fatalf("original added date lost: %s %s %v", id, added, err)
			}
		}
		if err := restored.DB.QueryRow("SELECT body FROM translations WHERE document_id='a'").Scan(&body); err != nil || !strings.Contains(body, "$$x=1$$") {
			t.Fatalf("formula lost: %s %v", body, err)
		}
		data, err := os.ReadFile(filepath.Join(destination, "cache", "a", "analysis", "figure.png"))
		if err != nil || string(data) != "original figure a" {
			t.Fatalf("cache lost: %v", err)
		}
		data, err = os.ReadFile(filepath.Join(destination, "attachments", attachment))
		if err != nil || string(data) != "attachment" {
			t.Fatalf("attachment lost: %v", err)
		}
		if err := restored.DB.QueryRow("SELECT count(*) FROM settings WHERE key='api:key'").Scan(&count); err != nil || count != 0 {
			t.Fatal("exported API key")
		}
		var migrated string
		if err := restored.DB.QueryRow("SELECT value FROM settings WHERE key=?", epubMetadataMigration).Scan(&migrated); err != nil || migrated != "already-migrated" {
			t.Fatal("lost library migration state")
		}
		var fingerprint string
		if err := restored.DB.QueryRow("SELECT fingerprint FROM document_corpora WHERE document_id='a'").Scan(&fingerprint); err != nil {
			t.Fatal(err)
		}
		expectedFingerprint, err := (&Server{Store: restored}).corpusFingerprint(Document{ID: "a", Type: "pdf"})
		if err != nil || fingerprint != expectedFingerprint {
			t.Fatal("corpus index was not rebound")
		}
		if scope.Folder != "" || scope.SmartCategory != "" {
			if _, err := os.Stat(filepath.Join(destination, "papers", "b.pdf")); !os.IsNotExist(err) {
				t.Fatal("unselected original exported")
			}
		}
		restored.DB.Close()
	}
}

func TestLibraryArchiveRejectsUnsafeOrIncompleteInput(t *testing.T) {
	for _, name := range []string{"../outside", "library/cache/../../outside", "library\\outside", "library/cache/link", "library/neoread.sqlite"} {
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			path := filepath.Join(parent, "bad.zip")
			out, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			archive := zip.NewWriter(out)
			manifest, _ := archive.Create("manifest.json")
			manifest.Write([]byte(`{"format":"neoread-library","version":1,"documents":1}`))
			header := &zip.FileHeader{Name: name, Method: zip.Deflate}
			if strings.HasSuffix(name, "link") {
				header.SetMode(os.ModeSymlink | 0600)
			}
			entry, err := archive.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			entry.Write([]byte("invalid database"))
			archive.Close()
			out.Close()
			destination := filepath.Join(parent, "restored")
			if err := ImportLibraryArchive(path, destination, ""); err == nil {
				t.Fatal("accepted invalid archive")
			}
			if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatal("published incomplete library")
			}
			if _, err := os.Stat(filepath.Join(parent, "outside")); !os.IsNotExist(err) {
				t.Fatal("escaped extraction directory")
			}
		})
	}
}

func TestLibraryArchiveOnlineImportKeepsSourceOpenAndMergeSettings(t *testing.T) {
	s := testServer(t)
	archiveDocument(t, s.Store, "existing", "原分类")
	config := AIConfig{Primary: "api", Models: map[string]string{"api": "local-model"}, TranslationModels: map[string]string{"api": "local-translation-model"}, API: APIConnection{URL: "https://example.test/api", Key: "LOCAL_CONFIG_ONLY"}}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("INSERT INTO settings(key,value) VALUES('api:key','LOCAL_ONLY')"); err != nil {
		t.Fatal(err)
	}
	incoming := archiveFixture(t, filepath.Join(t.TempDir(), "incoming"))
	archiveDocument(t, incoming, "incoming", "导入分类")
	if err := (&Server{Store: incoming}).writeAIConfig(AIConfig{Primary: "api", API: APIConnection{Key: "DO_NOT_EXPORT_CONFIG"}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "incoming.zip")
	incoming.DB.Close()
	if err := ExportLibraryArchive(incoming.Root, path, LibraryArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	unlock, err := LockLibrary(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	for _, merge := range []bool{false, true} {
		destination := filepath.Join(t.TempDir(), "prepared")
		body, _ := json.Marshal(map[string]any{"file": path, "destination": destination, "merge": merge})
		response := request(t, s, "POST", "/api/library/archive/import", bytes.NewReader(body))
		if response.Code != 200 {
			t.Fatalf("import %t: %d %s", merge, response.Code, response.Body.String())
		}
		restored := archiveFixture(t, destination)
		docs, err := restored.Documents()
		want := 1
		if merge {
			want = 2
		}
		if err != nil || len(docs) != want {
			t.Fatalf("prepared docs %d %v", len(docs), err)
		}
		if merge {
			var secret string
			if err = restored.DB.QueryRow("SELECT value FROM settings WHERE key='api:key'").Scan(&secret); err != nil || secret != "LOCAL_ONLY" {
				t.Fatal("local merge lost machine settings")
			}
			mergedConfig := (&Server{Store: restored}).readAIConfig()
			if mergedConfig.Primary != config.Primary || mergedConfig.API.Key != config.API.Key || mergedConfig.Models["api"] != config.Models["api"] || mergedConfig.TranslationModels["api"] != config.TranslationModels["api"] {
				t.Fatal("local merge lost AI connections or model choices")
			}
		} else if _, err := os.Stat(filepath.Join(destination, "ai-connections.json")); !os.IsNotExist(err) {
			t.Fatal("archive leaked machine AI connections", err)
		}
		if _, err = s.Store.DB.Exec("UPDATE documents SET title='Still live' WHERE id='existing'"); err != nil {
			t.Fatal(err)
		}
	}
}

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

func TestLibraryArchivePreservesPeakAndCurrentReadingPosition(t *testing.T) {
	store := archiveFixture(t, filepath.Join(t.TempDir(), "source"))
	archiveDocument(t, store, "paper", "Research")
	if _, err := store.DB.Exec(`UPDATE documents SET body_read_position=6.7,progress='{"type":"pdf","page":1}',percentage=.1 WHERE id='paper'`); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "library.zip")
	if err := ExportLibraryArchive(store.Root, archive, LibraryArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "restored")
	if err := ImportLibraryArchive(archive, destination, ""); err != nil {
		t.Fatal(err)
	}
	restored := archiveFixture(t, destination)
	doc, err := restored.Document("paper")
	if err != nil || doc.BodyReadPosition != 6.7 || !strings.Contains(string(doc.Progress), `"page":1`) {
		t.Fatalf("restored peak or location changed: %+v %v", doc, err)
	}
}
