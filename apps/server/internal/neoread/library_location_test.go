package neoread

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func migrationSource(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "source")
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(`INSERT INTO settings VALUES('migration-test','notes and settings')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,percentage) VALUES('test-document','pdf','Migration paper','Author',9,'now','now',0.5);
 INSERT INTO document_notes VALUES('test-document','Keep my notes','now');
 INSERT INTO annotations VALUES('annotation','test-document','{"text":"Keep my highlight"}');`)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Close(); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"papers/paper.pdf": "pdf bytes", "books/book.epub": "epub bytes", "cache/analysis.md": "analysis", "attachments/supplement": "attachment bytes", "server.json": "stale token", "ai-work/transient": "temporary"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}
func TestCopyLibraryPreservesSourceAndDatabase(t *testing.T) {
	source := migrationSource(t)
	target := filepath.Join(t.TempDir(), "新书库 # &")
	if err := CopyLibrary(source, target); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{source, target} {
		b, err := os.ReadFile(filepath.Join(root, "papers/paper.pdf"))
		if err != nil || string(b) != "pdf bytes" {
			t.Fatal(string(b), err)
		}
		b, err = os.ReadFile(filepath.Join(root, "attachments/supplement"))
		if err != nil || string(b) != "attachment bytes" {
			t.Fatal("attachment migration", string(b), err)
		}
		s, err := OpenStore(root)
		if err != nil {
			t.Fatal(err)
		}
		var value string
		err = s.DB.QueryRow(`SELECT value FROM settings WHERE key='migration-test'`).Scan(&value)
		var note, annotation string
		var progress float64
		if err := s.DB.QueryRow("SELECT body FROM document_notes WHERE document_id='test-document'").Scan(&note); err != nil {
			t.Fatal(err)
		}
		if err := s.DB.QueryRow("SELECT body FROM annotations WHERE id='annotation'").Scan(&annotation); err != nil {
			t.Fatal(err)
		}
		if err := s.DB.QueryRow("SELECT percentage FROM documents WHERE id='test-document'").Scan(&progress); err != nil {
			t.Fatal(err)
		}
		if note != "Keep my notes" || annotation != `{"text":"Keep my highlight"}` || progress != 0.5 {
			t.Fatal(note, annotation, progress)
		}
		s.DB.Close()
		if err != nil || value != "notes and settings" {
			t.Fatal(value, err)
		}
	}
	for _, name := range []string{"server.json", "ai-work/transient"} {
		if _, err := os.Stat(filepath.Join(target, name)); !os.IsNotExist(err) {
			t.Fatalf("copied ephemeral file %s: %v", name, err)
		}
	}
}
func TestCopyLibraryRefusesExistingAndNestedTargets(t *testing.T) {
	source := migrationSource(t)
	existing := t.TempDir()
	if err := os.WriteFile(filepath.Join(existing, "keep"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{source, filepath.Join(source, "nested"), filepath.Dir(source), existing} {
		if err := CopyLibrary(source, target); err == nil {
			t.Fatalf("accepted %s", target)
		}
	}
	b, err := os.ReadFile(filepath.Join(existing, "keep"))
	if err != nil || string(b) != "untouched" {
		t.Fatal(err, string(b))
	}
}

func TestCopyLibraryRejectsQuestionMarkPathsBeforeCopying(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not allow question marks in directory names")
	}
	source := migrationSource(t)
	for _, relative := range []string{"NeoRead?Library", filepath.Join("parent?question", "NeoRead Library")} {
		t.Run(relative, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), relative)
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				t.Fatal(err)
			}
			if err := CopyLibrary(source, target); err == nil || !strings.Contains(err.Error(), "书库路径不能包含 ?") {
				t.Fatalf("expected path validation error, got %v", err)
			}
			if _, err := os.Stat(target); !os.IsNotExist(err) {
				t.Fatalf("created unsafe target: %v", err)
			}
		})
	}
	store, err := OpenStore(source)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	var note string
	if err := store.DB.QueryRow("SELECT body FROM document_notes WHERE document_id='test-document'").Scan(&note); err != nil || note != "Keep my notes" {
		t.Fatalf("source note changed: %q, %v", note, err)
	}
}

func TestCopyLibraryWaitsForSourceLock(t *testing.T) {
	source := migrationSource(t)
	target := filepath.Join(t.TempDir(), "target")
	unlock, err := LockLibrary(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := CopyLibrary(source, target); err == nil {
		t.Fatal("copied active library")
	}
	unlock()
	if err := CopyLibrary(source, target); err != nil {
		t.Fatal(err)
	}
}
func TestCopyLibraryRejectsLinksAndCleansPartialCopy(t *testing.T) {
	source := migrationSource(t)
	external := t.TempDir()
	if err := os.Symlink(external, filepath.Join(source, "linked")); err != nil {
		t.Skip(err)
	}
	target := filepath.Join(t.TempDir(), "target")
	assertInstallerFailure(t, CopyLibrary(source, target), "copy", "unsafe_location")
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("left partial target: %v", err)
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatal(err)
	}
}
func TestCopyLibraryRejectsMissingOrInvalidDatabase(t *testing.T) {
	for _, data := range []string{"", "not sqlite"} {
		source := t.TempDir()
		target := filepath.Join(t.TempDir(), "target")
		stage := "preflight"
		if data != "" {
			stage = "verify"
			if err := os.WriteFile(filepath.Join(source, "neoread.sqlite"), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
		}
		assertInstallerFailure(t, CopyLibrary(source, target), stage, "invalid_library")
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Fatalf("left target: %v", err)
		}
	}
}

func TestCopyLibraryRejectsEmptySQLiteFile(t *testing.T) {
	source := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(filepath.Join(source, "neoread.sqlite"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := CopyLibrary(source, target); err == nil {
		t.Fatal("accepted empty database")
	}
}
func TestCopyLibraryRecoversCommittedWAL(t *testing.T) {
	live := migrationSource(t)
	s, err := OpenStore(live)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("UPDATE document_notes SET body='Committed in WAL'"); err != nil {
		t.Fatal(err)
	}
	source := t.TempDir()
	for _, name := range []string{"neoread.sqlite", "neoread.sqlite-wal"} {
		data, err := os.ReadFile(filepath.Join(live, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(source, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	s.DB.Close()
	target := filepath.Join(t.TempDir(), "target")
	if err := CopyLibrary(source, target); err != nil {
		t.Fatal(err)
	}
	recovered, err := OpenStore(target)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.DB.Close()
	var note string
	if err := recovered.DB.QueryRow("SELECT body FROM document_notes WHERE document_id='test-document'").Scan(&note); err != nil {
		t.Fatal(err)
	}
	if note != "Committed in WAL" {
		t.Fatal(note)
	}
}

func TestLibraryDatabaseURI(t *testing.T) {
	for path, want := range map[string]string{
		"C:/NeoRead Library/neoread.sqlite":   "file:///C:/NeoRead%20Library/neoread.sqlite?mode=rw",
		"/tmp/NeoRead Library/neoread.sqlite": "file:///tmp/NeoRead%20Library/neoread.sqlite?mode=rw",
	} {
		if got := libraryDatabaseURI(path); got != want {
			t.Fatalf("%s: got %s, want %s", path, got, want)
		}
	}
}

func TestCopyLibraryPreservesCorpusOverviewAndReferences(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(fmt.Sprintf("stale=%t", stale), func(t *testing.T) {
			s, a := originalDocumentFixture(t)
			calls, failAt := 0, -1
			if err := s.compileOverview(t.Context(), overviewTestJob(t, s), overviewTestService(t, &calls, &failAt)); err != nil {
				t.Fatal(err)
			}
			reference := map[string]any{"sourceId": "S1", "corpusRevision": a.corpus.Revision, "text": "Original evidence", "contentHash": sourceKey("Original evidence")}
			if _, err := s.Store.DB.Exec("INSERT INTO messages VALUES('answer','doc',?,'now')", jsonText(map[string]any{"role": "assistant", "references": []any{reference}})); err != nil {
				t.Fatal(err)
			}
			if stale {
				if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "a.xhtml"), []byte("Changed original content"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			source := s.Store.Root
			s.Close()
			if err := s.Store.DB.Close(); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(t.TempDir(), "moved library")
			if err := CopyLibrary(source, target); err != nil {
				t.Fatal(err)
			}
			for _, root := range []string{source, target} {
				store, err := OpenStore(root)
				if err != nil {
					t.Fatal(err)
				}
				defer store.DB.Close()
				reopened := NewServer(store, "test-secret", "")
				defer reopened.Close()
				overview, err := reopened.overviewState(t.Context(), "doc")
				if err != nil || overview.Stale != stale {
					t.Fatalf("overview at %s: stale=%t want %t, %v", root, overview.Stale, stale, err)
				}
				w := request(t, reopened, "GET", "/api/documents/doc/messages/answer/sources/S1", nil)
				want := 200
				if stale {
					want = 409
				}
				if w.Code != want {
					t.Fatalf("reference at %s: %d want %d: %s", root, w.Code, want, w.Body.String())
				}
				var revision, body string
				if err := store.DB.QueryRow("SELECT revision,body FROM document_corpora WHERE document_id='doc'").Scan(&revision, &body); err != nil {
					t.Fatal(err)
				}
				if revision != a.corpus.Revision || body != jsonText(a.corpus) {
					t.Fatal("corpus content/revision changed")
				}
				if !stale {
					c, err := reopened.documentCorpus(t.Context(), "doc", func() error { return fmt.Errorf("unchanged corpus must not rebuild") })
					if err != nil || c.Revision != a.corpus.Revision {
						t.Fatal("cached corpus not reusable", err)
					}
				}
			}
		})
	}
}

func TestValidateLibraryPreservesDataAndRejectsInvalidLibraries(t *testing.T) {
	root := migrationSource(t)
	before, err := os.ReadFile(filepath.Join(root, "neoread.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateLibrary(root); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(root, "neoread.sqlite"))
	if err != nil || string(before) != string(after) {
		t.Fatal("validation modified database", err)
	}
	unlock, err := LockLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateLibrary(root); err == nil {
		t.Fatal("accepted an in-use library")
	}
	unlock()
	empty := t.TempDir()
	if err := ValidateLibrary(empty); err == nil {
		t.Fatal("accepted empty directory")
	}
	if _, err := os.Stat(filepath.Join(empty, "neoread.sqlite")); !os.IsNotExist(err) {
		t.Fatal("created a database")
	}
	if err := os.WriteFile(filepath.Join(empty, "neoread.sqlite"), []byte("not sqlite"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateLibrary(empty); err == nil {
		t.Fatal("accepted corrupt database")
	}
}

func TestValidateLegacyLibraryWithoutRenamingDatabase(t *testing.T) {
	root := migrationSource(t)
	if err := os.Rename(filepath.Join(root, "neoread.sqlite"), filepath.Join(root, "reader.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := ValidateLibrary(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "neoread.sqlite")); !os.IsNotExist(err) {
		t.Fatal("validation renamed legacy database")
	}
}

func TestValidateLibraryRejectsDanglingForeignKeys(t *testing.T) {
	for _, filename := range []string{"neoread.sqlite", "reader.sqlite"} {
		t.Run(filename, func(t *testing.T) {
			root := migrationSource(t)
			database := filepath.Join(root, filename)
			if filename != "neoread.sqlite" {
				if err := os.Rename(filepath.Join(root, "neoread.sqlite"), database); err != nil {
					t.Fatal(err)
				}
			}
			db, err := sql.Open("sqlite", libraryDatabaseURI(database))
			if err != nil {
				t.Fatal(err)
			}
			db.SetMaxOpenConns(1)
			defer db.Close()
			if _, err := db.Exec("PRAGMA foreign_keys=OFF"); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO annotations VALUES('orphan','missing-document','{}')`); err != nil {
				t.Fatal(err)
			}
			var result string
			if err := db.QueryRow("PRAGMA quick_check").Scan(&result); err != nil || result != "ok" {
				t.Fatalf("fixture must pass quick_check: %s, %v", result, err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(database)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateLibrary(root); err == nil || !strings.Contains(err.Error(), "外键") {
				t.Fatalf("expected foreign-key validation error, got %v", err)
			}
			after, err := os.ReadFile(database)
			if err != nil || string(before) != string(after) {
				t.Fatal("validation changed database", err)
			}
		})
	}
}
