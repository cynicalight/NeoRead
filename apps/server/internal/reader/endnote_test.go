package reader

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func endnoteFixture(t *testing.T) (string, *sql.DB) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "Test.enl")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`CREATE TABLE refs(id INTEGER,reference_type INTEGER,title TEXT,author TEXT,year TEXT,secondary_title TEXT,volume TEXT,number TEXT,pages TEXT,publisher TEXT,electronic_resource_number TEXT,url TEXT,abstract TEXT,keywords TEXT,notes TEXT,research_notes TEXT,trash_state INTEGER); CREATE TABLE file_res(refs_id INTEGER,file_path TEXT,file_pos INTEGER);INSERT INTO refs VALUES(1,0,'论文','Ada Lovelace','2025','Journal','1','2','3-4','Publisher','10.1000/test','','Abstract','tag','note','research',0); INSERT INTO file_res VALUES(1,'123/paper.pdf',0);`)
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(dir, "Test.Data", "PDF", "123")
	if err = os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(folder, "paper.pdf"), testPDF(2), 0600); err != nil {
		t.Fatal(err)
	}
	return path, db
}
func TestEndnoteReadOnlyAndPaths(t *testing.T) {
	path, db := endnoteFixture(t)
	before, _ := os.ReadFile(path)
	scan, err := endnoteSource(context.Background(), filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Entries) != 1 || scan.Entries[0].Issue != "" || scan.Entries[0].metadata.DOI != "10.1000/test" {
		t.Fatalf("%+v", scan)
	}
	after, _ := os.ReadFile(path)
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("source database changed")
	}
	if _, err = endnoteLibraryPath(strings.TrimSuffix(path, ".enl") + ".Data"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("UPDATE file_res SET file_path='../../escape.pdf'"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(filepath.Dir(path), "Test.Data", "escape.pdf"), testPDF(1), 0600); err != nil {
		t.Fatal(err)
	}
	scan, err = endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if scan.Entries[0].Issue == "" {
		t.Fatal("escape accepted")
	}
}
func TestEndnoteLockedLibraryAndAmbiguousDirectory(t *testing.T) {
	path, db := endnoteFixture(t)
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err = conn.ExecContext(context.Background(), "BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	if _, err = endnoteSource(context.Background(), path); err == nil {
		t.Fatal("locked source accepted")
	}
	conn.ExecContext(context.Background(), "ROLLBACK")
	os.WriteFile(filepath.Join(filepath.Dir(path), "Other.enl"), nil, 0600)
	if _, err = endnoteLibraryPath(filepath.Dir(path)); err == nil {
		t.Fatal("ambiguous source accepted")
	}
}
func TestEndnoteImportAtomicAndRepeatable(t *testing.T) {
	path, _ := endnoteFixture(t)
	scan, err := endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	e := scan.Entries[0]
	original, _ := os.ReadFile(e.path)
	s := testServer(t)
	calls := 0
	convert := func(ctx context.Context, input, work string) (string, endnotePDFResult, error) {
		calls++
		dest := filepath.Join(work, "cleaned.pdf")
		if err := os.WriteFile(dest, testPDF(1), 0600); err != nil {
			return "", endnotePDFResult{}, err
		}
		return dest, endnotePDFResult{Marks: []endnotePDFMark{{Key: "1:4R", Kind: "underline", Location: json.RawMessage(`{"type":"pdf","page":1,"rects":[{"x":0.1,"y":0.1,"width":0.2,"height":0.03}]}`), Color: "#fc6a08"}}}, nil
	}
	result, err := s.importEndnoteEntry(context.Background(), e, "papers", true, convert)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "imported" || result.Annotations != 1 || result.Notes != 1 {
		t.Fatalf("%+v", result)
	}
	if _, err = s.Store.DB.Exec("DELETE FROM annotations WHERE document_id=?", result.DocumentID); err != nil {
		t.Fatal(err)
	}
	again, err := s.importEndnoteEntry(context.Background(), e, "papers", true, convert)
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != "exists" || calls != 1 {
		t.Fatalf("%+v calls=%d", again, calls)
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM annotations").Scan(&count)
	if count != 0 {
		t.Fatal("deleted annotation resurrected")
	}
	after, _ := os.ReadFile(e.path)
	if sha256.Sum256(original) != sha256.Sum256(after) {
		t.Fatal("source PDF changed")
	}
	entries, _ := os.ReadDir(s.Store.Root)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "endnote-") {
			t.Fatal("temporary original retained")
		}
	}
}
func TestEndnoteFailedConversionLeavesNoDocument(t *testing.T) {
	path, _ := endnoteFixture(t)
	scan, err := endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	_, err = s.importEndnoteEntry(context.Background(), scan.Entries[0], "papers", true, func(context.Context, string, string) (string, endnotePDFResult, error) {
		return "", endnotePDFResult{}, errors.New("failure")
	})
	if err == nil {
		t.Fatal("expected failure")
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 0 {
		t.Fatal("partial document committed")
	}
}

// Opt-in integration check against a disposable SQLite snapshot and local PDFs.
// Never requires a private library in CI and never edits the source library.
func TestEndnoteLiveSnapshot(t *testing.T) {
	path := os.Getenv("READER_TEST_ENDNOTE_LIBRARY")
	if path == "" {
		t.Skip("set READER_TEST_ENDNOTE_LIBRARY to a disposable snapshot")
	}
	scan, err := endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	total := 0
	for _, e := range scan.Entries {
		if e.Issue != "" {
			t.Fatalf("unavailable sample: %s", e.Issue)
		}
		before, err := os.ReadFile(e.path)
		if err != nil {
			t.Fatal(err)
		}
		result, err := s.importEndnoteEntry(context.Background(), e, "papers", true, migrateEndnotePDF)
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != "imported" {
			t.Fatalf("%+v", result)
		}
		total += result.Annotations
		again, err := s.importEndnoteEntry(context.Background(), e, "papers", true, migrateEndnotePDF)
		if err != nil || again.Status != "exists" {
			t.Fatalf("retry: %+v %v", again, err)
		}
		after, _ := os.ReadFile(e.path)
		if sha256.Sum256(before) != sha256.Sum256(after) {
			t.Fatal("source changed")
		}
	}
	if total == 0 {
		t.Fatal("sample has no converted marks")
	}
	t.Logf("imported %d PDFs and %d native annotations; repeat skipped; sources unchanged", len(scan.Entries), total)
}

func TestEndnoteMixedAttachmentLimitIsExplicit(t *testing.T) {
	path, db := endnoteFixture(t)
	_, err := db.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<20001) INSERT INTO file_res SELECT 1,'other.txt',x FROM n`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = endnoteSource(context.Background(), path); err == nil || !strings.Contains(err.Error(), "20000") {
		t.Fatalf("expected explicit limit, got %v", err)
	}
}
