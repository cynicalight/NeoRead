package neoread

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeIdentifiers(t *testing.T) {
	for in, want := range map[string]string{
		"10.1145/3290605.3300857":          "10.1145/3290605.3300857",
		"https://doi.org/10.1000/ABC.def":  "10.1000/ABC.def",
		"doi: 10.1000/xyz123.":             "10.1000/xyz123",
		"https://dx.doi.org/10.1000/a%2Fb": "10.1000/a/b",
	} {
		if got := NormalizeDOI(in); got != want {
			t.Errorf("DOI %q: %q", in, got)
		}
	}
	for in, want := range map[string]string{
		"2401.01234":                             "2401.01234",
		"arXiv:2401.01234v2":                     "2401.01234v2",
		"https://arxiv.org/abs/2401.01234":       "2401.01234",
		"https://arxiv.org/pdf/2401.01234v3.pdf": "2401.01234v3",
		"hep-th/9901001":                         "hep-th/9901001",
	} {
		if got := NormalizeArXiv(in); got != want {
			t.Errorf("arXiv %q: %q", in, got)
		}
	}
}
func TestManualMetadataValidation(t *testing.T) {
	var m PaperMetadata
	for _, patch := range []string{
		`{"doi":"11.1/x"}`, `{"arxiv":"abc"}`, `{"date":"May 2024"}`, `{"url":"javascript:alert(1)"}`,
		`{"itemType":"blog"}`, `{"venue":"line\nbreak"}`, `{"unknown":"x"}`, `{"creators":"Ada"}`, `{"doi":7}`,
	} {
		var raw map[string]json.RawMessage
		_ = json.Unmarshal([]byte(patch), &raw)
		if err := m.ApplyManual(raw); err == nil {
			t.Errorf("accepted %s", patch)
		}
	}
	// A rejected patch leaves every field unchanged.
	var raw map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"venue":"NeurIPS","doi":"bad"}`), &raw)
	if m.ApplyManual(raw) == nil || m.Venue != "" {
		t.Fatalf("partial apply: %+v", m)
	}
	_ = json.Unmarshal([]byte(`{"doi":"https://doi.org/10.1000/X","abstract":"line one\nline two","remark":"组会讲\n第二部分","creators":[{"given":"Ada","family":"Lovelace"},{"given":"张三"},{"family":""}]}`), &raw)
	if err := m.ApplyManual(raw); err != nil {
		t.Fatal(err)
	}
	if m.DOI != "10.1000/X" || !strings.Contains(m.Abstract, "\n") || len(m.Creators) != 2 || m.Creators[1].Name != "张三" || m.Sources["doi"] != "manual" || m.Remark != "组会讲\n第二部分" {
		t.Fatalf("manual: %+v", m)
	}
	if CreatorNames(m.Creators) != "Ada Lovelace, 张三" {
		t.Fatal(CreatorNames(m.Creators))
	}
}
func TestMergeLookupReplacesExistingValues(t *testing.T) {
	m := PaperMetadata{Venue: "My venue", Sources: map[string]string{"venue": "manual"}}
	found := PaperMetadata{Venue: "ICML", Date: "2024-07", DOI: "doi.org/10.5555/abc", Creators: []Creator{{Given: "A", Family: "B"}}}
	changed := m.Merge(found, "file")
	if m.Venue != "My venue" || m.Date != "2024-07" || m.DOI != "10.5555/abc" || len(m.Creators) != 1 || len(changed) != 3 {
		t.Fatalf("file merge: %+v %v", m, changed)
	}
	// File metadata only fills gaps; lookup values replace existing fields.
	m.Merge(PaperMetadata{Date: "2023"}, "file")
	if m.Date != "2024-07" {
		t.Fatal("file overwrote a value")
	}
	m.Merge(PaperMetadata{Date: "2023", Venue: "Other"}, "lookup")
	if m.Date != "2023" || m.Sources["date"] != "lookup" || m.Venue != "Other" || m.Sources["venue"] != "lookup" {
		t.Fatalf("lookup merge: %+v", m)
	}
	m.Merge(PaperMetadata{DOI: "not a doi"}, "lookup")
	if m.DOI != "10.5555/abc" {
		t.Fatal("invalid lookup value accepted")
	}
}
func TestPatchPaperMetadataAndReadingStatus(t *testing.T) {
	s := testServer(t)
	d := organizationDoc(t, s)
	if d.ReadingStatus != "unread" || d.Metadata.Sources != nil {
		t.Fatalf("new document: %+v", d)
	}
	if w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"doi":"bad"}}`)); w.Code != 400 || !strings.Contains(w.Body.String(), "DOI") {
		t.Fatalf("bad DOI: %d %s", w.Code, w.Body.String())
	}
	w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"Attention","metadata":{"creators":[{"given":"Ashish","family":"Vaswani"}],"date":"2017","venue":"NeurIPS"}}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ := s.Store.Document(d.ID)
	if got.Author != "Ashish Vaswani" || got.Metadata.Venue != "NeurIPS" || got.Metadata.Sources["title"] != "manual" || got.LastOpenedAt != d.LastOpenedAt {
		t.Fatalf("metadata: %+v", got)
	}
	if w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"readingStatus":"later"}`)); w.Code != 400 {
		t.Fatalf("bad status: %d", w.Code)
	}
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"percentage":0.2,"progress":{"type":"pdf","page":2}}`))
	if got, _ = s.Store.Document(d.ID); got.ReadingStatus != "reading" {
		t.Fatalf("progress did not start reading: %s", got.ReadingStatus)
	}
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"readingStatus":"done"}`))
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"percentage":0.3,"progress":{"type":"pdf","page":3}}`))
	if got, _ = s.Store.Document(d.ID); got.ReadingStatus != "done" {
		t.Fatalf("progress overrode a finished status: %s", got.ReadingStatus)
	}
}
func TestDocumentAnnotationCounts(t *testing.T) {
	s := testServer(t)
	d := organizationDoc(t, s)
	for i, kind := range []string{"note", "note", "highlight", "underline", "bookmark"} {
		if _, err := s.Store.DB.Exec(`INSERT INTO annotations VALUES(?, ?, ?)`, kind+string(rune('a'+i)), d.ID, `{"kind":"`+kind+`"}`); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := s.Store.Document(d.ID)
	if got.NoteCount != 2 || got.HighlightCount != 2 {
		t.Fatalf("counts: %+v", got)
	}
}
func TestReadingStatusMigration(t *testing.T) {
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "neoread.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,progress TEXT,percentage REAL NOT NULL DEFAULT 0);
 INSERT INTO documents VALUES('a','pdf','A','',1,'t','t',0,NULL,0),('b','pdf','B','',1,'t','t',0,NULL,0.4),('c','pdf','C','',1,'t','t',0,NULL,1);`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	for id, want := range map[string]string{"a": "unread", "b": "reading", "c": "done"} {
		if d, _ := store.Document(id); d.ReadingStatus != want {
			t.Fatalf("%s: %s", id, d.ReadingStatus)
		}
	}
}
