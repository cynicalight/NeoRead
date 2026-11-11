package neoread

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func epubAnnotationSaveFixture(t *testing.T) (*Server, epubTranslationDocument) {
	t.Helper()
	s := testServer(t)
	if _, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,percentage) VALUES('doc','epub','Book','',0,'now','now',0)`); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(s.Store.Root, "cache", "doc")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"manifest.json": `{"readingOrder":[{"href":"z.xhtml","type":"application/xhtml+xml"},{"href":"a.xhtml","type":"application/xhtml+xml"}]}`,
		"z.xhtml":       "<html><body><p>ababa 😀</p><p>middle</p></body></html>",
		"a.xhtml":       "<html><body><p>ending</p></body></html>",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var blocks epubTranslationDocument
	for _, href := range []string{"z.xhtml", "a.xhtml"} {
		r := request(t, s, "GET", "/api/documents/doc/epub-chapter?href="+href, nil)
		if r.Code != 200 {
			t.Fatal(r.Body.String())
		}
		var chapter struct {
			Blocks epubTranslationDocument `json:"blocks"`
		}
		if err := json.Unmarshal(r.Body.Bytes(), &chapter); err != nil {
			t.Fatal(err)
		}
		blocks = append(blocks, chapter.Blocks...)
	}
	return s, blocks
}

func epubSaveMark(id string, blocks epubTranslationDocument, first, last, start, end int, quote string) Annotation {
	loc, _ := json.Marshal(map[string]any{"type": "epub", "href": blocks[first].Location.Href, "blockId": blocks[first].ID, "endBlockId": blocks[last].ID, "endHref": blocks[last].Location.Href, "start": start, "end": end, "order": blocks[first].Location.Order})
	return Annotation{ID: id, DocumentID: "doc", Kind: "highlight", Color: "yellow", Location: loc, Quote: quote}
}

func TestEPUBSaveReusesReadingBlocksWithoutParsingOtherChapters(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	filename := filepath.Join(s.Store.Root, "cache", "doc", "z.xhtml")
	cached := s.Store.epubBlocksCache[filename].blocks
	if len(cached) == 0 {
		t.Fatal("reader did not populate chapter cache")
	}
	if err := os.Remove(filepath.Join(s.Store.Root, "cache", "doc", "a.xhtml")); err != nil {
		t.Fatal(err)
	}
	for _, a := range []Annotation{
		epubSaveMark("first", blocks, 0, 1, 0, 4, "ababa 😀\n\nmidd"),
		epubSaveMark("second", blocks, 1, 1, 2, 6, "ddle"),
	} {
		result, err := s.Store.saveAnnotation(a)
		if err != nil {
			t.Fatal(err)
		}
		if a.ID == "second" && (result.ID != "first" || result.Quote != "ababa 😀\n\nmiddle") {
			t.Fatalf("cross-paragraph merge failed: %+v", result)
		}
	}
	if &s.Store.epubBlocksCache[filename].blocks[0] != &cached[0] {
		t.Fatal("save reparsed the chapter instead of reusing reading blocks")
	}
}

func TestEPUBSaveOnlyCompactsMarksConnectedToIncomingMark(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	s.Store.epubBlocksCache = nil
	for _, a := range []Annotation{
		epubSaveMark("old-a", blocks, 0, 0, 0, 3, "aba"),
		epubSaveMark("old-b", blocks, 0, 0, 2, 5, "aba"),
	} {
		body, _ := json.Marshal(a)
		if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", a.ID, a.DocumentID, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	note := epubSaveMark("note", blocks, 1, 1, 0, 6, "middle")
	note.Kind = "note"
	if _, err := s.Store.saveAnnotation(note); err != nil {
		t.Fatal(err)
	}
	if len(s.Store.epubBlocksCache) != 0 {
		t.Fatal("saving a note parsed EPUB chapters")
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM annotations").Scan(&count); err != nil || count != 3 {
		t.Fatalf("old marks were compacted: %d, %v", count, err)
	}
	result, err := s.Store.saveAnnotation(epubSaveMark("new", blocks, 0, 0, 4, 5, "a"))
	if err != nil || result.ID != "old-a" || result.Quote != "ababa" || len(result.ReplacedIDs) != 1 || result.ReplacedIDs[0] != "old-b" {
		t.Fatalf("transitive merge failed: %+v, %v", result, err)
	}
}

func TestEPUBAnnotationAPISkipsSourceParsingWithoutMergeCandidates(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	s.Store.epubBlocksCache = nil
	for _, a := range []Annotation{
		epubSaveMark("", blocks, 0, 0, 0, 3, "aba"),
		epubSaveMark("", blocks, 2, 2, 0, 3, "end"),
	} {
		body, _ := json.Marshal(a)
		r := request(t, s, "POST", "/api/documents/doc/annotations", bytes.NewReader(body))
		if r.Code != 201 {
			t.Fatal(r.Body.String())
		}
		if len(s.Store.epubBlocksCache) != 0 {
			t.Fatal("saving unrelated highlights parsed EPUB chapters")
		}
	}
}

func TestEPUBSaveMergesAcrossChapters(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	for _, a := range []Annotation{
		epubSaveMark("first", blocks, 0, 1, 0, 4, "ababa 😀\n\nmidd"),
		epubSaveMark("second", blocks, 1, 2, 2, 3, "ddle\n\nend"),
	} {
		result, err := s.Store.saveAnnotation(a)
		if err != nil {
			t.Fatal(err)
		}
		if a.ID == "second" && result.Quote != "ababa 😀\n\nmiddle\n\nend" {
			t.Fatalf("cross-chapter merge failed: %+v", result)
		}
	}
}

func TestEPUBChapterBlocksCacheInvalidatesChangedOrMissingSources(t *testing.T) {
	s, _ := epubAnnotationSaveFixture(t)
	filename := filepath.Join(s.Store.Root, "cache", "doc", "z.xhtml")
	if err := os.WriteFile(filename, []byte("<html><body><p>changed source text</p></body></html>"), 0600); err != nil {
		t.Fatal(err)
	}
	blocks, err := s.Store.readEPUBChapterBlocks("doc", "z.xhtml", "z.xhtml")
	if err != nil || len(blocks) != 1 || blocks[0].Text != "changed source text" {
		t.Fatalf("stale chapter cache: %+v, %v", blocks, err)
	}
	if err := os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.readEPUBChapterBlocks("doc", "z.xhtml", "z.xhtml"); err == nil {
		t.Fatal("missing source served from cache")
	}
}

func TestEPUBReadingOrderUsesManifestAndSurvivesAnnotationSave(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	want := []EPUBReadingOrder{{Chapter: 0, Block: 0}, {Chapter: 0, Block: 1}, {Chapter: 1, Block: 0}}
	for i, block := range blocks {
		if block.Location.Order == nil || *block.Location.Order != want[i] {
			t.Fatalf("chapter API order %d: %+v", i, block.Location.Order)
		}
	}
	all, err := s.readEPUBBlocks("doc")
	if err != nil {
		t.Fatal(err)
	}
	for i, block := range all {
		if block.Location.Order == nil || *block.Location.Order != want[i] {
			t.Fatalf("full block API order %d: %+v", i, block.Location.Order)
		}
	}
	// Saving a new note needs only the location that came with its paragraph.
	note := epubSaveMark("note", blocks, 2, 2, 0, 3, "end")
	note.Kind = "note"
	s.Store.epubBlocksCache = nil
	if err := os.RemoveAll(filepath.Join(s.Store.Root, "cache", "doc")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.saveAnnotation(note); err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "GET", "/api/documents/doc/annotations", nil)
	var saved []Annotation
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &saved) != nil || len(saved) != 1 {
		t.Fatal(response.Body.String())
	}
	var location EPUBReadingLocation
	if json.Unmarshal(saved[0].Location, &location) != nil || location.Order == nil || *location.Order != want[2] {
		t.Fatalf("saved annotation lost order: %s", saved[0].Location)
	}
	if len(s.Store.epubBlocksCache) != 0 {
		t.Fatal("annotation save/list parsed chapter text")
	}
}

func TestEPUBMergeUpdatesOrderWhenStartMovesToEarlierParagraph(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	older := epubSaveMark("older", blocks, 1, 1, 1, 5, "iddl")
	if _, err := s.Store.saveAnnotation(older); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Store.saveAnnotation(epubSaveMark("expanded", blocks, 0, 1, 2, 3, "aba 😀\n\nmid"))
	if err != nil {
		t.Fatal(err)
	}
	var location EPUBReadingLocation
	if json.Unmarshal(saved.Location, &location) != nil || saved.ID != "older" || location.BlockID != blocks[0].ID || location.Order == nil || *location.Order != *blocks[0].Location.Order {
		t.Fatalf("merge retained old paragraph order: %s", saved.Location)
	}
}
