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

func TestEndnoteNullableMetadataDoesNotBlockOtherPapers(t *testing.T) {
	path, db := endnoteFixture(t)
	_, err := db.Exec(`INSERT INTO refs (id,reference_type,trash_state) VALUES(2,0,0); INSERT INTO file_res VALUES(2,'123/nullable.pdf',0)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "Test.Data", "PDF", "123", "nullable.pdf"), testPDF(1), 0600); err != nil {
		t.Fatal(err)
	}
	scan, err := endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Entries) != 2 {
		t.Fatalf("expected two papers, got %d", len(scan.Entries))
	}
	regular, nullable := scan.Entries[0], scan.Entries[1]
	if regular.metadata.DOI != "10.1000/test" || regular.Title != "论文" || regular.Notes != 1 {
		t.Fatalf("populated metadata lost: %+v", regular)
	}
	if nullable.Title != "nullable" || nullable.Notes != 0 || nullable.note != "" || len(nullable.Tags) != 0 || len(nullable.metadata.Creators) != 0 {
		t.Fatalf("unexpected NULL defaults: %+v", nullable)
	}
	if nullable.metadata.Date != "" || nullable.metadata.Venue != "" || nullable.metadata.Volume != "" || nullable.metadata.Issue != "" || nullable.metadata.Pages != "" || nullable.metadata.Publisher != "" || nullable.metadata.DOI != "" || nullable.metadata.URL != "" || nullable.metadata.Abstract != "" {
		t.Fatalf("unexpected metadata: %+v", nullable.metadata)
	}
	s := testServer(t)
	convert := func(ctx context.Context, input, work string) (string, endnotePDFResult, error) {
		data, err := os.ReadFile(input)
		if err != nil {
			return "", endnotePDFResult{}, err
		}
		dest := filepath.Join(work, "cleaned.pdf")
		return dest, endnotePDFResult{}, os.WriteFile(dest, data, 0600)
	}
	for _, e := range scan.Entries {
		if e.Issue != "" {
			t.Fatalf("unavailable PDF: %s", e.Issue)
		}
		result, err := s.importEndnoteEntry(context.Background(), e, "papers", true, convert)
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != "imported" {
			t.Fatalf("import failed: %+v", result)
		}
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("expected two imported documents, got %d", count)
	}
}

func TestEndnoteDifferentSourceSamePDFReportsUnmergedData(t *testing.T) {
	path, db := endnoteFixture(t)
	_, err := db.Exec(`INSERT INTO refs (id,reference_type,title,notes,keywords,trash_state) VALUES(2,0,'Other title','Other note','Other tag',0); INSERT INTO file_res VALUES(2,'123/paper.pdf',0)`)
	if err != nil {
		t.Fatal(err)
	}
	scan, err := endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	calls := 0
	convert := func(ctx context.Context, input, work string) (string, endnotePDFResult, error) {
		calls++
		return input, endnotePDFResult{}, nil
	}
	first, err := s.importEndnoteEntry(context.Background(), scan.Entries[0], "papers", true, convert)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		result, err := s.importEndnoteEntry(context.Background(), scan.Entries[1], "papers", true, convert)
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != "exists" || !strings.Contains(strings.Join(result.Warnings, ""), "未合并此来源的标题、元数据、标签和笔记") {
			t.Fatalf("silent skip: %+v", result)
		}
	}
	repeat, err := s.importEndnoteEntry(context.Background(), scan.Entries[0], "papers", true, convert)
	if err != nil || repeat.Status != "exists" || len(repeat.Warnings) != 0 || calls != 1 {
		t.Fatalf("repeat: %+v %v calls=%d", repeat, err, calls)
	}
	doc, err := s.Store.Document(first.DocumentID)
	if err != nil || doc.Title != "论文" {
		t.Fatalf("existing title changed: %+v %v", doc, err)
	}
	var note string
	if err := s.Store.DB.QueryRow("SELECT body FROM document_notes WHERE document_id=?", first.DocumentID).Scan(&note); err != nil || note != "note\n\nresearch" {
		t.Fatalf("existing note changed: %q %v", note, err)
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM endnote_imports").Scan(&count); err != nil || count != 1 {
		t.Fatalf("unexpected migration records: %d %v", count, err)
	}
}

func TestEndnoteRejectedMetadataIsReportedAndArchived(t *testing.T) {
	path, db := endnoteFixture(t)
	abstract := strings.Repeat("a", 20001)
	if _, err := db.Exec("UPDATE refs SET year=?,url=?,abstract=?,author=?", "2024a", "ftp://example.org/paper", abstract, strings.Repeat("b", 201)); err != nil {
		t.Fatal(err)
	}
	scan, err := endnoteSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	result, err := s.importEndnoteEntry(context.Background(), scan.Entries[0], "papers", true, func(ctx context.Context, input, work string) (string, endnotePDFResult, error) {
		return input, endnotePDFResult{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "imported" {
		t.Fatalf("%+v", result)
	}
	warnings := strings.Join(result.Warnings, "\n")
	for _, key := range []string{"date", "url", "abstract", "creators"} {
		if !strings.Contains(warnings, metadataLabels[key]+"未转换") {
			t.Fatalf("missing %s warning: %s", key, warnings)
		}
	}
	doc, err := s.Store.Document(result.DocumentID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Metadata.Date != "" || doc.Metadata.URL != "" || doc.Metadata.Abstract != "" || len(doc.Metadata.Creators) != 0 || doc.Author != "" || doc.Metadata.DOI != "10.1000/test" {
		t.Fatalf("unexpected metadata: %+v", doc)
	}
	var raw []byte
	if err := s.Store.DB.QueryRow("SELECT body FROM endnote_imports WHERE source_id=?", scan.Entries[0].ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var archive struct {
		Metadata PaperMetadata `json:"metadata"`
		Warnings []string      `json:"warnings"`
	}
	if err := json.Unmarshal(raw, &archive); err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Date != "2024a" || archive.Metadata.URL != "ftp://example.org/paper" || archive.Metadata.Abstract != abstract || len(archive.Metadata.Creators[0].Name) != 201 || len(archive.Warnings) != len(result.Warnings) {
		t.Fatal("source values or warnings missing from archive")
	}
}
