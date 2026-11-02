package neoread

import (
	"strings"
	"testing"
)

func TestBodyReadPositionKeepsPeakAndCurrentLocationAfterReopening(t *testing.T) {
	s := testServer(t)
	bodyProgressPaper(t, s.Store)
	for _, step := range []struct {
		body string
		peak float64
	}{
		{`{"progress":{"type":"pdf","page":1},"percentage":0.1}`, 0},
		{`{"progress":{"type":"pdf","page":5,"y":0.4},"percentage":0.5}`, 4.4},
		{`{"progress":{"type":"pdf","page":2,"y":0.1},"percentage":0.2}`, 4.4},
		{`{"progress":{"type":"pdf","page":1},"percentage":0.1,"bodyReadPosition":6.7}`, 6.7},
	} {
		w := request(t, s, "PATCH", "/api/documents/paper", strings.NewReader(step.body))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		doc, err := s.Store.Document("paper")
		if err != nil || doc.BodyReadPosition != step.peak {
			t.Fatalf("peak lost: %v %v", doc.BodyReadPosition, err)
		}
	}
	s.Store.DB.Close()
	restored, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.DB.Close()
	doc, err := restored.Document("paper")
	if err != nil || doc.BodyReadPosition != 6.7 || !strings.Contains(string(doc.Progress), `"page":1`) {
		t.Fatalf("restored peak or current location changed: %+v %v", doc, err)
	}
}

func TestBodyReadPositionMigratesExistingReadingLocation(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	bodyProgressPaper(t, store)
	if _, err := store.DB.Exec(`UPDATE documents SET percentage=.5,progress='{"type":"pdf","page":4,"y":0.3}'; ALTER TABLE documents DROP COLUMN body_read_position`); err != nil {
		t.Fatal(err)
	}
	store.DB.Close()
	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	doc, err := reopened.Document("paper")
	if err != nil || doc.BodyReadPosition != 3.3 {
		t.Fatalf("migration: %+v %v", doc, err)
	}
}

func bodyProgressPaper(t *testing.T, store *Store) {
	t.Helper()
	if _, err := store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES('paper','pdf','Paper','Author',8,'2021-02-03','2021-02-03','papers')`); err != nil {
		t.Fatal(err)
	}
}

func TestBodyEndNeedsCompleteLayoutAndIgnoresRunningHeaders(t *testing.T) {
	layout := layoutManifest{Pages: 10, ParsedPages: []int{1, 7}, Blocks: []PDFBlock{
		{Page: 1, Label: "header", Text: "References"},
		{Page: 7, Label: "paragraph_title", Text: "7 References"},
	}}
	layout.Blocks[1].Bounds.Y = .3
	if end := layoutBodyEnd(layout); end != nil {
		t.Fatalf("partial layout reported completion: %+v", end)
	}
	for page := 2; page <= 10; page++ {
		layout.ParsedPages = append(layout.ParsedPages, page)
	}
	if end := layoutBodyEnd(layout); end == nil || end.Page != 7 || end.Y != .3 {
		t.Fatalf("reference start: %+v", end)
	}
	layout.Blocks = layout.Blocks[:1]
	if end := layoutBodyEnd(layout); end == nil || end.Page != 10 || end.Y != 1 {
		t.Fatalf("header-only fallback: %+v", end)
	}
}
