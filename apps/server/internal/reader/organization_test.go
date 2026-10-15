package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOrganizationMigrationNormalizesLegacyZoteroJSON(t *testing.T) {
	s := testServer(t)
	ids := uploadPapers(t, s, 5)
	metadata := `{ "doi": "10.1000/example", "sources": { "doi": "manual" } }`
	tags := `[ "研究", "ML" ]`
	folders := `[ "AI/Security" ]`
	before := make([]Document, len(ids))
	for i, id := range ids {
		// Include already-correct TEXT, mixed storage types, and a trashed row.
		var metaValue, tagsValue, foldersValue any = metadata, tags, folders
		if i == 1 || i == 4 {
			metaValue = []byte(metadata)
		}
		if i == 2 || i == 4 {
			tagsValue = []byte(tags)
		}
		if i == 3 || i == 4 {
			foldersValue = []byte(folders)
		}
		deletedAt := ""
		if i == 4 {
			deletedAt = now()
		}
		if _, err := s.Store.DB.Exec(`UPDATE documents SET metadata=?,tags=?,folders=?,deleted_at=?,favorite=1,reading_status='reading',percentage=0.5,progress='{"type":"pdf","page":1}' WHERE id=?`, metaValue, tagsValue, foldersValue, deletedAt, id); err != nil {
			t.Fatal(err)
		}
		var err error
		before[i], err = s.Store.Document(id)
		if err != nil {
			t.Fatal(err)
		}
	}
	root := s.Store.Root
	s.Close()
	if err := s.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	// Reopening twice checks that the repair is idempotent.
	for range 2 {
		store, err := OpenStore(root)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { store.DB.Close() })
		for i, id := range ids {
			var metaType, tagsType, foldersType, gotMeta, gotTags, gotFolders string
			if err := store.DB.QueryRow(`SELECT typeof(metadata),typeof(tags),typeof(folders),metadata,tags,folders FROM documents WHERE id=?`, id).Scan(&metaType, &tagsType, &foldersType, &gotMeta, &gotTags, &gotFolders); err != nil {
				t.Fatal(err)
			}
			if metaType != "text" || tagsType != "text" || foldersType != "text" {
				t.Fatalf("document %d storage types: %s/%s/%s", i, metaType, tagsType, foldersType)
			}
			if gotMeta != metadata || gotTags != tags || gotFolders != folders {
				t.Fatalf("document %d JSON changed during migration", i)
			}
			after, err := store.Document(id)
			if err != nil || !reflect.DeepEqual(before[i], after) {
				t.Fatalf("document %d changed during migration: %+v %v", i, after, err)
			}
		}
		if err := store.DB.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func organizationDoc(t *testing.T, s *Server) Document {
	t.Helper()
	w := upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf"))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	return d
}
func TestOrganizationMigrationPreservesLibrary(t *testing.T) {
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "reader.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,progress TEXT,percentage REAL NOT NULL DEFAULT 0);
 INSERT INTO documents VALUES('old','epub','Existing','Author',123,'before','before',1,'{"type":"epub","href":"chapter.xhtml"}',0.5);`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	d, err := store.Document("old")
	if err != nil {
		t.Fatal(err)
	}
	if d.Category != "book" || d.ClassificationStatus != "pending" || len(d.Tags) != 0 || !d.Favorite || d.Percentage != .5 || !strings.Contains(string(d.Progress), "chapter.xhtml") {
		t.Fatalf("migration lost data: %+v", d)
	}
	_, err = store.DB.Exec("UPDATE documents SET category='paper',category_source='manual',tags='[\"Security\"]' WHERE id='old'")
	if err != nil {
		t.Fatal(err)
	}
	store.DB.Close()
	store, err = OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	d, err = store.Document("old")
	if err != nil || d.Category != "paper" || len(d.Tags) != 1 {
		t.Fatalf("reopen: %+v %v", d, err)
	}
}
func TestOrganizationPatchValidationAndIsolation(t *testing.T) {
	s := testServer(t)
	d := organizationDoc(t, s)
	for _, body := range []string{`{"category":null}`, `{"category":"pdf"}`, `{"category":""}`, `{"tags":null}`, `{"tags":[1]}`, `{"tags":[""]}`, `{"tags":["line\nbreak"]}`} {
		w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(body))
		if w.Code != 400 {
			t.Fatalf("accepted %s: %d", body, w.Code)
		}
	}
	w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"category":"paper","tags":[" Security ","security","论文笔记"]}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ := s.Store.Document(d.ID)
	if got.Category != "paper" || got.CategorySource != "manual" || got.ClassificationStatus != "done" || len(got.Tags) != 2 || got.Tags[0] != "Security" || got.LastOpenedAt != d.LastOpenedAt {
		t.Fatalf("patch: %+v", got)
	}
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"percentage":0.3,"progress":{"type":"pdf","page":2}}`))
	w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"tags":[]}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ = s.Store.Document(d.ID)
	if got.CategorySource != "manual" || got.Category != "paper" || len(got.Tags) != 0 || got.Percentage != .3 {
		t.Fatalf("unrelated metadata lost: %+v", got)
	}
	w = request(t, s, "POST", "/api/documents/"+d.ID+"/classification", nil)
	if w.Code != 409 {
		t.Fatal("manual classification was requeued")
	}
}
func TestClassificationCompletionAndManualRace(t *testing.T) {
	for _, scenario := range []string{"success", "invalid", "incomplete", "manual", "tags", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			s := testServer(t)
			d := organizationDoc(t, s)
			dir := s.analysisDir(d.ID)
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			block := PDFBlock{ID: "p1-b1", Page: 1, Text: "Abstract: We evaluate a new security analysis method."}
			block.Bounds.Width = 1
			block.Bounds.Height = 1
			manifest, _ := json.Marshal(layoutManifest{Pages: 1, Blocks: []PDFBlock{block}})
			if err := os.WriteFile(filepath.Join(dir, "manifest.json"), manifest, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			service := &GenerationService{primary: "codex", connections: map[string]generationConnection{"codex": {VerifiedText: true, Adapter: adapterFunc(func(_ context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
				if !strings.Contains(req.Input.Prompt, "Abstract: We evaluate") || !strings.Contains(req.Input.Prompt, "untrusted document data") {
					t.Fatal("missing document boundary")
				}
				if scenario == "manual" {
					w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"category":"book","tags":["mine"]}`))
					if w.Code != 200 {
						t.Fatal(w.Body.String())
					}
				}
				if scenario == "tags" {
					request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"tags":["mine"]}`))
				}
				text := `{"category":"paper"}`
				if scenario == "invalid" {
					text = `{"category":"pdf"}`
				}
				if err := emit(ProviderEvent{Text: text}); err != nil {
					return GenerateResult{}, err
				}
				if scenario == "cancel" {
					cancel()
					return GenerateResult{}, context.Canceled
				}
				if scenario == "incomplete" {
					return GenerateResult{}, errors.New("missing terminal")
				}
				return GenerateResult{Text: text, FinishReason: "stop"}, nil
			})}}}
			if _, err := s.Store.DB.Exec("UPDATE documents SET classification_status='pending' WHERE id=?", d.ID); err != nil {
				t.Fatal(err)
			}
			s.classifyDocument(ctx, d.ID, service)
			got, err := s.Store.Document(d.ID)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "success", "tags":
				if got.Category != "paper" || got.CategorySource != "ai" || got.ClassificationStatus != "done" {
					t.Fatalf("result: %+v", got)
				}
				if scenario == "tags" && len(got.Tags) != 1 {
					t.Fatal("lost tags")
				}
			case "manual":
				if got.Category != "book" || got.CategorySource != "manual" || len(got.Tags) != 1 {
					t.Fatalf("overwrote manual: %+v", got)
				}
			case "cancel":
				if got.ClassificationStatus != "pending" || got.CategorySource != "default" {
					t.Fatalf("cancellation: %+v", got)
				}
			default:
				if got.ClassificationStatus != "failed" || got.CategorySource != "default" {
					t.Fatalf("saved invalid result: %+v", got)
				}
				w := request(t, s, "POST", "/api/documents/"+d.ID+"/classification", nil)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
				got, _ = s.Store.Document(d.ID)
				if got.ClassificationStatus != "pending" {
					t.Fatal("retry did not queue")
				}
			}
		})
	}
}

func TestClassificationEvidenceComesFromEachFormat(t *testing.T) {
	s := testServer(t)
	d := organizationDoc(t, s)
	if _, err := s.classificationInput(d); err == nil {
		t.Fatal("classified a PDF without extracted text")
	}
	w := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	input, err := s.classificationInput(d)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(input.Prompt, `"excerpts":[`) || strings.Contains(input.Prompt, `"excerpts":null`) {
		t.Fatal("missing EPUB excerpts")
	}
}
