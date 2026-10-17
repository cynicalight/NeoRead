package reader

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testPDF builds a minimal valid PDF with blank pages and a correct xref table.
func testPDF(pages int) []byte {
	var b bytes.Buffer
	offsets := []int{}
	object := func(body string) {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	b.WriteString("%PDF-1.4\n")
	object("<< /Type /Catalog /Pages 2 0 R >>")
	kids := []string{}
	for i := range pages {
		kids = append(kids, fmt.Sprintf("%d 0 R", i+3))
	}
	object(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages))
	for range pages {
		object("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	return b.Bytes()
}
func uploadTo(t *testing.T, s *Server, library, name string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	if library != "" {
		_ = m.WriteField("library", library)
	}
	f, _ := m.CreateFormFile("file", name)
	f.Write(data)
	m.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents", &body)
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", m.FormDataContentType())
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func TestPDFPageCount(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []int{1, 7} {
		path := filepath.Join(dir, fmt.Sprintf("%d.pdf", n))
		if err := os.WriteFile(path, testPDF(n), 0600); err != nil {
			t.Fatal(err)
		}
		if got, err := pdfPageCount(path); err != nil || got != n {
			t.Fatalf("pages %d: %d %v", n, got, err)
		}
	}
	path := filepath.Join(dir, "sample.pdf")
	if err := os.WriteFile(path, sample(t, "reading-notes.pdf"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := pdfPageCount(path); err != nil || got < 1 {
		t.Fatalf("sample: %d %v", got, err)
	}
	broken := filepath.Join(dir, "broken.pdf")
	if err := os.WriteFile(broken, []byte("%PDF-1.4\nnot a pdf"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := pdfPageCount(broken); err == nil {
		t.Fatal("broken PDF counted")
	}
}
func TestPaperLibraryImportLimits(t *testing.T) {
	s := testServer(t)
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(3))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Library != "papers" || d.Category != "paper" || d.CategorySource != "manual" || d.ClassificationStatus != "done" {
		t.Fatalf("paper import: %+v", d)
	}
	if w = uploadTo(t, s, "papers", "book.epub", sample(t, "the-art-of-reading.epub")); w.Code != 400 || !strings.Contains(w.Body.String(), "只支持 PDF") {
		t.Fatalf("epub accepted into papers: %d %s", w.Code, w.Body.String())
	}
	if w = uploadTo(t, s, "papers", "long.pdf", testPDF(largePaperPages+1)); w.Code != 409 || !strings.Contains(w.Body.String(), "large-paper") {
		t.Fatalf("long PDF accepted: %d %s", w.Code, w.Body.String())
	}
	if w = uploadTo(t, s, "shelf", "x.pdf", testPDF(1)); w.Code != 400 {
		t.Fatalf("unknown library accepted: %d", w.Code)
	}
	// The same file in the book library is accepted there without limits.
	if w = uploadTo(t, s, "", "long.pdf", testPDF(largePaperPages+1)); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil || d.Library != "books" {
		t.Fatalf("default library: %+v %v", d, err)
	}
	if reason := paperLimit("pdf", largePaperBytes+1, ""); reason != "" {
		t.Fatalf("size limit: %q", reason)
	}
}
func TestMoveDocumentBetweenLibraries(t *testing.T) {
	s := testServer(t)
	long := uploadTo(t, s, "books", "long.pdf", testPDF(largePaperPages+1))
	short := uploadTo(t, s, "books", "short.pdf", testPDF(2))
	var longDoc, shortDoc Document
	_ = json.Unmarshal(long.Body.Bytes(), &longDoc)
	_ = json.Unmarshal(short.Body.Bytes(), &shortDoc)
	if w := request(t, s, "PATCH", "/api/documents/"+longDoc.ID, strings.NewReader(`{"library":"papers"}`)); w.Code != 200 {
		t.Fatalf("long PDF moved: %d", w.Code)
	}
	if w := request(t, s, "PATCH", "/api/documents/"+shortDoc.ID, strings.NewReader(`{"library":"nowhere"}`)); w.Code != 400 {
		t.Fatalf("unknown library: %d", w.Code)
	}
	if w := request(t, s, "PATCH", "/api/documents/"+shortDoc.ID, strings.NewReader(`{"library":"papers"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ := s.Store.Document(shortDoc.ID)
	if got.Library != "papers" || got.Category != "paper" || got.CategorySource != "manual" || got.LastOpenedAt != shortDoc.LastOpenedAt {
		t.Fatalf("moved: %+v", got)
	}
	if w := request(t, s, "PATCH", "/api/documents/"+shortDoc.ID, strings.NewReader(`{"library":"books"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if got, _ = s.Store.Document(shortDoc.ID); got.Library != "books" || got.Category != "paper" {
		t.Fatalf("moved back: %+v", got)
	}
}
func TestLibraryMigrationKeepsPapersTogether(t *testing.T) {
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "reader.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,progress TEXT,percentage REAL NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT 'article',category_source TEXT NOT NULL DEFAULT 'default',classification_status TEXT NOT NULL DEFAULT 'pending',classification_error TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '[]');
 INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,category) VALUES('paper','pdf','Paper','',100,'t','t','paper'),('huge','pdf','Huge','',99999999,'t','t','paper'),('article','pdf','Article','',100,'t','t','article'),('book','epub','Book','',100,'t','t','book');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	want := map[string]string{"paper": "papers", "huge": "books", "article": "books", "book": "books"}
	for id, library := range want {
		if d, err := store.Document(id); err != nil || d.Library != library {
			t.Fatalf("%s: %+v %v", id, d, err)
		}
	}
}
func TestLibraryPreferences(t *testing.T) {
	s := testServer(t)
	if w := request(t, s, "GET", "/api/preferences/library", nil); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "{}" {
		t.Fatalf("empty: %d %s", w.Code, w.Body.String())
	}
	if w := request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{"mode":"papers","pinned":["tag:ML"]}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := request(t, s, "GET", "/api/preferences/library", nil)
	if !strings.Contains(w.Body.String(), `"mode":"papers"`) {
		t.Fatal(w.Body.String())
	}
	if w = request(t, s, "PUT", "/api/preferences/guide", strings.NewReader(`{"onboarded":true,"seenVersion":"0.3.0"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = request(t, s, "GET", "/api/preferences/guide", nil); !strings.Contains(w.Body.String(), `"seenVersion":"0.3.0"`) {
		t.Fatal(w.Body.String())
	}
	if w = request(t, s, "GET", "/api/preferences/library", nil); strings.Contains(w.Body.String(), "seenVersion") {
		t.Fatalf("keys share a value: %s", w.Body.String())
	}
	if w = request(t, s, "PUT", "/api/preferences/other", strings.NewReader(`{}`)); w.Code != 404 {
		t.Fatalf("unknown key: %d", w.Code)
	}
	if w = request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`[1]`)); w.Code != 400 {
		t.Fatalf("non-object: %d", w.Code)
	}
}
func TestRenameAndRemoveLibraryTag(t *testing.T) {
	s := testServer(t)
	ids := []string{}
	for i, library := range []string{"papers", "papers", "books"} {
		w := uploadTo(t, s, library, fmt.Sprintf("p%d.pdf", i), testPDF(i+1))
		var d Document
		_ = json.Unmarshal(w.Body.Bytes(), &d)
		ids = append(ids, d.ID)
	}
	request(t, s, "PATCH", "/api/documents/"+ids[0], strings.NewReader(`{"tags":["ML","Vision"]}`))
	request(t, s, "PATCH", "/api/documents/"+ids[1], strings.NewReader(`{"tags":["ml","NLP"]}`))
	request(t, s, "PATCH", "/api/documents/"+ids[2], strings.NewReader(`{"tags":["ML"]}`))
	request(t, s, "POST", "/api/documents/"+ids[1]+"/trash", nil)
	w := request(t, s, "POST", "/api/libraries/papers/tags", strings.NewReader(`{"from":"ML","to":"NLP"}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"changed":2`) {
		t.Fatal(w.Body.String())
	}
	a, _ := s.Store.Document(ids[0])
	b, _ := s.Store.Document(ids[1])
	c, _ := s.Store.Document(ids[2])
	if strings.Join(a.Tags, ",") != "NLP,Vision" || strings.Join(b.Tags, ",") != "NLP" || strings.Join(c.Tags, ",") != "ML" {
		t.Fatalf("rename: %v %v %v", a.Tags, b.Tags, c.Tags)
	}
	if w = request(t, s, "POST", "/api/libraries/papers/tags", strings.NewReader(`{"from":"NLP"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a, _ = s.Store.Document(ids[0])
	if strings.Join(a.Tags, ",") != "Vision" {
		t.Fatalf("remove: %v", a.Tags)
	}
	if w = request(t, s, "POST", "/api/libraries/papers/tags", strings.NewReader(`{"from":"Vision","to":" "}`)); w.Code != 400 {
		t.Fatalf("blank rename: %d", w.Code)
	}
	if w = request(t, s, "POST", "/api/libraries/shelf/tags", strings.NewReader(`{"from":"x"}`)); w.Code != 404 {
		t.Fatalf("unknown library: %d", w.Code)
	}
}

func TestFoldersNestButTagsStayFlat(t *testing.T) {
	s := testServer(t)
	w := uploadTo(t, s, "papers", "p.pdf", testPDF(1))
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"folders":["ML/Vision","ml/NLP/Parsing","MLOps"],"tags":["ML","ML/x"]}`))
	if w = request(t, s, "POST", "/api/libraries/papers/folders", strings.NewReader(`{"from":"ML","to":"AI"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	d, _ = s.Store.Document(d.ID)
	if strings.Join(d.Folders, ",") != "AI/Vision,AI/NLP/Parsing,MLOps" || strings.Join(d.Tags, ",") != "ML,ML/x" {
		t.Fatalf("folder rename: folders=%v tags=%v", d.Folders, d.Tags)
	}
	if w = request(t, s, "POST", "/api/libraries/papers/folders", strings.NewReader(`{"from":"AI/NLP"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = request(t, s, "POST", "/api/libraries/papers/tags", strings.NewReader(`{"from":"ML","to":"Learning"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	d, _ = s.Store.Document(d.ID)
	if strings.Join(d.Folders, ",") != "AI/Vision,MLOps" || strings.Join(d.Tags, ",") != "Learning,ML/x" {
		t.Fatalf("folders=%v tags=%v", d.Folders, d.Tags)
	}
	long := strings.Repeat("x", 39)
	if w = request(t, s, "POST", "/api/libraries/papers/folders", strings.NewReader(`{"from":"AI","to":"`+long+`"}`)); w.Code != 400 {
		t.Fatalf("too long after rename: %d", w.Code)
	}
	if w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"folders":"x"}`)); w.Code != 400 {
		t.Fatalf("bad folders: %d", w.Code)
	}
}

func TestShortcutPreferences(t *testing.T) {
	s := testServer(t)
	if w := request(t, s, "PUT", "/api/preferences/shortcuts", strings.NewReader(`{"readerLeft":{"key":"b","shift":true}}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := request(t, s, "GET", "/api/preferences/shortcuts", nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"key":"b"`) {
		t.Fatal(w.Body.String())
	}
	if w := request(t, s, "GET", "/api/preferences/guide", nil); strings.Contains(w.Body.String(), "readerLeft") {
		t.Fatal("shortcut preferences overwrite guide")
	}
}
