package neoread

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestEPUBLocatorValidation(t *testing.T) {
	for _, locator := range []string{
		`null`, `[]`, `not JSON`,
		`{"href":"https://example.test/chapter.xhtml","type":"text/html"}`,
		`{"href":"other.xhtml","type":"text/html"}`,
		`{"href":"chapter.xhtml","type":"text/html","locations":{"progression":2}}`,
		`{"href":"chapter.xhtml","type":"text/html","locations":{"domRange":{"start":{"cssSelector":"p","textNodeIndex":-1}}}}`,
		`{"href":"chapter.xhtml","type":"text/html","locations":{"domRange":{"end":{"cssSelector":"p"}}}}`,
		`{"href":"chapter.xhtml","type":"text/html","locations":{"textRange":{"start":5,"end":2}}}`,
	} {
		location, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": locator})
		if validLocation(location, "epub") {
			t.Errorf("accepted %s", locator)
		}
	}
	for _, locator := range []string{"", "{}", `{"href":"chapter.xhtml","type":"text/html","locations":{"progression":0.8}}`} {
		location, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": locator})
		if !validLocation(location, "epub") {
			t.Errorf("rejected compatible progress %s", locator)
		}
	}
}
func TestEPUBExactAnnotationSurvivesReopen(t *testing.T) {
	s := testServer(t)
	w := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var document Document
	if err := json.Unmarshal(w.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	blocks, err := s.readEPUBBlocks(document.ID)
	if err != nil {
		t.Fatal(err)
	}
	block := blocks[0]
	locator := legacyBlockLocator(block)

	location, _ := json.Marshal(map[string]any{"type": "epub", "href": block.Location.Href, "locator": locator, "quote": block.Text})
	body, _ := json.Marshal(Annotation{Kind: "note", Location: location, Quote: block.Text, Note: "Keep this note", Color: "#e6b94c"})
	w = request(t, s, "POST", "/api/documents/"+document.ID+"/annotations", bytes.NewReader(body))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var created Annotation
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	reopened := NewServer(store, "test-secret", "")
	w = request(t, reopened, "GET", "/api/documents/"+document.ID+"/annotations", nil)
	var annotations []Annotation
	if err := json.Unmarshal(w.Body.Bytes(), &annotations); err != nil || len(annotations) != 1 {
		t.Fatalf("%s: %v", w.Body.String(), err)
	}
	var saved struct {
		Locator string `json:"locator"`
		BlockID string `json:"blockId"`
	}
	json.Unmarshal(annotations[0].Location, &saved)
	if saved.Locator != "" || saved.BlockID != block.ID || annotations[0].Note != "Keep this note" {
		t.Fatal("annotation changed during persistence")
	}
	w = request(t, reopened, "DELETE", "/api/documents/"+document.ID+"/annotations/"+created.ID, nil)
	if w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	w = request(t, reopened, "GET", "/api/documents/"+document.ID+"/annotations", nil)
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal("deleted annotation remains", w.Body.String())
	}
}
