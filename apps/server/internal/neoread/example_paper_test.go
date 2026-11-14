package neoread

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestNewLibraryExample(t *testing.T) {
	root := t.TempDir()
	s, err := OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	var paper bundledPaper
	raw, _ := examplePaper.ReadFile("example-paper/paper.json")
	if err = json.Unmarshal(raw, &paper); err != nil {
		t.Fatal(err)
	}
	doc, err := s.Document(paper.ID)
	if err != nil || doc.Title != "Attention Is All You Need" {
		t.Fatalf("document: %v %v", doc, err)
	}
	server := NewServer(s, "test", "")
	layout, err := server.readLayout(paper.ID)
	if err != nil || layout.Pages != 15 {
		t.Fatalf("layout: %v", err)
	}
	translations, err := server.translations(paper.ID, layout)
	if err != nil || len(translations) != 122 {
		t.Fatalf("translations: %d %v", len(translations), err)
	}
	for _, tr := range translations {
		if tr.Status != "complete" {
			t.Fatalf("unfinished translation: %s", tr.BlockID)
		}
	}
	for _, block := range layout.Blocks {
		if block.Image != "" {
			if _, err = os.Stat(filepath.Join(server.analysisDir(paper.ID), block.Image)); err != nil {
				t.Fatal(err)
			}
		}
	}
	p, err := s.processing(paper.ID)
	if err != nil || p.Phase != "ready" || p.Status != "complete" {
		t.Fatalf("processing: %+v %v", p, err)
	}
	var prefs string
	if err = s.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:guide'").Scan(&prefs); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains([]byte(prefs), []byte(paper.ID)) {
		t.Fatal("missing onboarding example")
	}
	// Restart does not duplicate, and purging every document never seeds or
	// onboards again.
	s.DB.Close()
	s, err = OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 1 {
		t.Fatalf("duplicate documents: %d", count)
	}
	if _, err = s.DB.Exec("DELETE FROM documents"); err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	for range 2 {
		s, err = OpenLibrary(root)
		if err != nil {
			t.Fatal(err)
		}
		s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
		if count != 0 {
			t.Fatal("emptied library was reseeded")
		}
		var onboarded bool
		if err = s.DB.QueryRow("SELECT json_extract(value,'$.onboarded') FROM settings WHERE key='preferences:guide'").Scan(&onboarded); err != nil {
			t.Fatal(err)
		}
		if !onboarded {
			t.Fatal("emptied library triggered onboarding again")
		}
		s.DB.Close()
	}
}

func TestExampleAfterReaderMigration(t *testing.T) {
	for _, external := range []bool{false, true} {
		for _, empty := range []bool{false, true} {
			name := fmt.Sprintf("external=%t/empty=%t", external, empty)
			t.Run(name, func(t *testing.T) {
				old, current, lib := legacyFixture(t, external)
				if empty {
					original, err := OpenStore(lib)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = original.DB.Exec("DELETE FROM documents"); err != nil {
						t.Fatal(err)
					}
					original.DB.Close()
					if err = os.Rename(filepath.Join(lib, "neoread.sqlite"), filepath.Join(lib, "reader.sqlite")); err != nil {
						t.Fatal(err)
					}
				}
				migrated, err := MigrateReaderData(old, current)
				if err != nil {
					t.Fatal(err)
				}
				s, err := OpenLibrary(migrated.Library)
				if err != nil {
					t.Fatal(err)
				}
				defer s.DB.Close()
				var title string
				if err = s.DB.QueryRow("SELECT title FROM documents").Scan(&title); err != nil {
					t.Fatal(err)
				}
				want := "Paper"
				if empty {
					want = "Attention Is All You Need"
				}
				if title != want {
					t.Fatalf("got %s, want %s", title, want)
				}
				var count int
				s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
				if count != 1 {
					t.Fatalf("documents: %d", count)
				}
				var onboarded bool
				if err = s.DB.QueryRow("SELECT json_extract(value,'$.onboarded') FROM settings WHERE key='preferences:guide'").Scan(&onboarded); err != nil {
					t.Fatal(err)
				}
				if onboarded == empty {
					t.Fatalf("onboarded=%t for empty=%t", onboarded, empty)
				}
			})
		}
	}
}

func TestExampleInitializationRecovery(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	// Reuse a PDF published by an interrupted initialization, before DB commit.
	raw, _ := examplePaper.ReadFile("example-paper/paper.json")
	var paper bundledPaper
	json.Unmarshal(raw, &paper)
	pdf, _ := examplePaper.ReadFile("example-paper/paper.pdf")
	if err = os.WriteFile(filepath.Join(root, "papers", paper.ID+".pdf"), pdf, 0600); err != nil {
		t.Fatal(err)
	}
	s, err = OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	s, err = OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 1 {
		t.Fatal("recovery duplicated example")
	}
	var onboarded bool
	if err = s.DB.QueryRow("SELECT json_extract(value,'$.onboarded') FROM settings WHERE key='preferences:guide'").Scan(&onboarded); err != nil {
		t.Fatal(err)
	}
	if !onboarded {
		t.Fatal("existing example triggered onboarding again")
	}
}

func TestExamplePreservesOrphanedLibraryFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "papers", "user.pdf")
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("user content"), 0600)
	s, err := OpenLibrary(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 1 {
		t.Fatal("empty database did not receive example")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "user content" {
		t.Fatal("modified user content")
	}
}

func TestExampleRecoveryPreservesConflictingFile(t *testing.T) {
	root := t.TempDir()
	var paper bundledPaper
	raw, _ := examplePaper.ReadFile("example-paper/paper.json")
	json.Unmarshal(raw, &paper)
	path := filepath.Join(root, "papers", paper.ID+".pdf")
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("preserve this file"), 0600)
	if s, err := OpenLibrary(root); err == nil {
		s.DB.Close()
		t.Fatal("overwrote conflicting file")
	}
	raw, _ = os.ReadFile(path)
	if string(raw) != "preserve this file" {
		t.Fatal("user file changed")
	}
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var count int
	s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 0 {
		t.Fatal("partial example published")
	}
}
