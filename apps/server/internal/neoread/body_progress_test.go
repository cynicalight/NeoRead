package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestBodyEndUsesReferencesAndExcludesRunningHeaders(t *testing.T) {
	layout := layoutManifest{Pages: 10, Blocks: []PDFBlock{{Page: 1, Label: "header", Text: "References"}, {Page: 7, Label: "paragraph_title", Text: "7 References"}, {Page: 7, Label: "reference_content"}}}
	layout.Blocks[0].Bounds.Y = .1
	layout.Blocks = append(layout.Blocks, PDFBlock{Page: 2, Label: "reference_content", Text: "A misclassified citation"})
	layout.Blocks[1].Bounds.Y = .3
	layout.Blocks[2].Bounds.Y = .4
	end := layoutBodyEnd(layout)
	if end.Page != 7 || end.Y != .3 {
		t.Fatalf("wrong body end: %+v", end)
	}
	layout.Blocks = nil
	end = layoutBodyEnd(layout)
	if end.Page != 10 || end.Y != 1 {
		t.Fatalf("fallback: %+v", end)
	}
}
func TestBodyEndRequiresAllParsedPages(t *testing.T) {
	layout := layoutManifest{Pages: 3, ParsedPages: []int{1, 3}}
	if layoutBodyEnd(layout) != nil {
		t.Fatal("partial parsing reported body completion")
	}
	layout.ParsedPages = []int{1, 2, 3}
	if end := layoutBodyEnd(layout); end == nil || end.Page != 3 || end.Y != 1 {
		t.Fatal("complete parsing missing body end")
	}
}
func TestBodyEndBackfillsCachedPapersWithoutChangingReadingState(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,percentage,progress) VALUES('paper','pdf','P','A',1,'now','now','papers',.5,'{"type":"pdf","page":4,"y":0.3}')`)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "cache", "paper", "analysis")
	os.MkdirAll(dir, 0700)
	body := []byte(`{"pages":10,"blocks":[{"id":"p7-b1","page":7,"label":"paragraph_title","text":"参考文献","bounds":{"x":0.1,"y":0.3,"width":0.8,"height":0.1}}]}`)
	os.WriteFile(filepath.Join(dir, "manifest.json"), body, 0600)
	store.DB.Close()
	store, err = OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	doc, err := store.Document("paper")
	if err != nil {
		t.Fatal(err)
	}
	if doc.BodyEnd == nil || doc.BodyEnd.Page != 7 || doc.BodyEnd.Y != .3 || doc.Percentage != .5 {
		t.Fatalf("body end or progress changed: %+v", doc)
	}
	var progress map[string]any
	if err = json.Unmarshal(doc.Progress, &progress); err != nil || progress["page"] != float64(4) {
		t.Fatal("reading location changed")
	}
}
