package neoread

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

func TestLibraryArchiveMergeKeepsExistingAndUsesImportedVersion(t *testing.T) {
	parent := t.TempDir()
	incoming := archiveFixture(t, filepath.Join(parent, "incoming-source"))
	archiveDocument(t, incoming, "shared", "导入分类")
	if _, err := incoming.DB.Exec("UPDATE documents SET created_at='2018-06-12T12:34:56Z'"); err != nil {
		t.Fatal(err)
	}
	incoming.DB.Close()
	archivePath := filepath.Join(parent, "incoming.zip")
	if err := ExportLibraryArchive(incoming.Root, archivePath, LibraryArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	current := archiveFixture(t, filepath.Join(parent, "current"))
	archiveDocument(t, current, "existing", "当前分类")
	archiveDocument(t, current, "shared", "旧分类")
	if _, err := current.DB.Exec("UPDATE documents SET created_at='2023-08-10T10:00:00Z' WHERE id='existing'"); err != nil {
		t.Fatal(err)
	}
	if _, err := current.DB.Exec("UPDATE document_notes SET body='旧笔记' WHERE document_id='shared'"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current.Root, "cache", "shared", "stale.png"), []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	current.DB.Close()
	destination := filepath.Join(parent, "merged")
	if err := ImportLibraryArchive(archivePath, destination, current.Root); err != nil {
		t.Fatal(err)
	}
	merged := archiveFixture(t, destination)
	docs, err := merged.Documents()
	if err != nil || len(docs) != 2 {
		t.Fatalf("merge docs: %d %v", len(docs), err)
	}
	var note string
	for id, date := range map[string]string{"shared": "2018-06-12T12:34:56Z", "existing": "2023-08-10T10:00:00Z"} {
		var added string
		if err := merged.DB.QueryRow("SELECT created_at FROM documents WHERE id=?", id).Scan(&added); err != nil || added != date {
			t.Fatalf("merged added date changed: %s %s %v", id, added, err)
		}
	}
	if err := merged.DB.QueryRow("SELECT body FROM document_notes WHERE document_id='shared'").Scan(&note); err != nil || note != "# 笔记\n原样保存" {
		t.Fatal("did not use imported snapshot")
	}
	if _, err := os.Stat(filepath.Join(destination, "cache", "shared", "stale.png")); !os.IsNotExist(err) {
		t.Fatal("stale cache retained")
	}
	original := archiveFixture(t, current.Root)
	if err := original.DB.QueryRow("SELECT body FROM document_notes WHERE document_id='shared'").Scan(&note); err != nil || note != "旧笔记" {
		t.Fatal("source library mutated")
	}
}

func TestLibraryArchiveHTTPLeavesTheLiveLibraryOpen(t *testing.T) {
	s := testServer(t)
	var synchronousBefore int
	if err := s.Store.DB.QueryRow("PRAGMA synchronous").Scan(&synchronousBefore); err != nil {
		t.Fatal(err)
	}
	archiveDocument(t, s.Store, "live", "研究")
	unlock, err := LockLibrary(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	response := request(t, s, "POST", "/api/library/archive/export", strings.NewReader("{}"))
	if response.Code != 200 {
		t.Fatalf("export: %d %s", response.Code, response.Body.String())
	}
	var synchronousAfter int
	if err := s.Store.DB.QueryRow("PRAGMA synchronous").Scan(&synchronousAfter); err != nil || synchronousAfter != synchronousBefore {
		t.Fatal("export changed live database durability")
	}
	archive, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range archive.File {
		if file.Name == "library/papers/live.pdf" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing original")
	}
	if response := request(t, s, "GET", "/api/documents", nil); response.Code != 200 {
		t.Fatal("library no longer available")
	}
	if _, err := s.Store.DB.Exec("UPDATE document_notes SET body='still writable' WHERE document_id='live'"); err != nil {
		t.Fatal(err)
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
	if _, err := s.Store.DB.Exec("INSERT INTO settings(key,value) VALUES('api:key','LOCAL_ONLY')"); err != nil {
		t.Fatal(err)
	}
	incoming := archiveFixture(t, filepath.Join(t.TempDir(), "incoming"))
	archiveDocument(t, incoming, "incoming", "导入分类")
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
		}
		if _, err = s.Store.DB.Exec("UPDATE documents SET title='Still live' WHERE id='existing'"); err != nil {
			t.Fatal(err)
		}
	}
}
