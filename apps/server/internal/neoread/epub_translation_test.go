package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEPUBTextBlocksPreserveNestedTextAndUTF16(t *testing.T) {
	source := `<html><body><div>Before <strong>😀</strong><p> Same <em>words</em>. </p>After<p>Same <em>words</em>.</p></div></body></html>`
	blocks, err := epubTextBlocks("EPUB/a.xhtml", source)
	if err != nil || len(blocks) != 4 {
		t.Fatalf("%+v %v", blocks, err)
	}
	expected := []string{"Before 😀", "Same words.", "After", "Same words."}
	ids := map[string]bool{}
	for i, b := range blocks {
		if b.Text != expected[i] || ids[b.ID] || !validEPUBLocator(b.Location.Locator, b.Location.Href) {
			t.Fatalf("invalid block: %+v", b)
		}
		ids[b.ID] = true
	}
	var loc annotationLocator
	_ = json.Unmarshal([]byte(blocks[0].Location.Locator), &loc)
	if loc.Locations.DOMRange.End.CharOffset != 2 || loc.Locations.TextRange.End != 9 {
		t.Fatalf("wrong UTF16 offsets: %+v", loc.Locations)
	}
	again, _ := epubTextBlocks("EPUB/a.xhtml", source)
	if again[1].ID != blocks[1].ID {
		t.Fatal("unstable ID")
	}
}
func TestEPUBTranslationUsesSharedQueueAndPersistsAcrossRetries(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var doc Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &doc) != nil {
		t.Fatal(response.Body.String())
	}
	p, err := s.Store.processing(doc.ID)
	if err != nil || !p.Enabled || p.Status != "complete" || p.Translating == nil || p.Translating.Status != "complete" {
		t.Fatalf("EPUB did not wait for a chapter request: %+v %v", p, err)
	}
	blocks, err := s.readEPUBBlocks(doc.ID)
	if err != nil || len(blocks) == 0 {
		t.Fatalf("no blocks: %v", err)
	}
	response = request(t, s, "GET", "/api/documents/"+doc.ID+"/epub-blocks", nil)
	if response.Code != 200 || strings.Contains(response.Body.String(), `"page":`) {
		t.Fatal(response.Body.String())
	}
	// Explicit requests select the work exercised by this retry test.
	for _, block := range blocks {
		if block.Image != "" {
			continue
		}
		response = request(t, s, "POST", "/api/documents/"+doc.ID+"/translations", strings.NewReader(`{"blockId":"`+block.ID+`"}`))
		if response.Code != 202 {
			t.Fatal(response.Body.String())
		}
	}
	p, _ = s.Store.processing(doc.ID)
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		batch := readTranslationInput(t, r).Batch
		var out strings.Builder
		for i, paragraph := range batch.Paragraphs {
			line := translationParagraphLine(paragraph)
			if i == 0 && calls == 1 {
				continue // Skipped by the first request.
			}
			if i == 0 && calls == 2 { // The automatic follow-up answers a stale source.
				line = strings.Replace(line, paragraph.SourceHash, "stale", 1)
			}
			out.WriteString(line)
		}
		writeAPIReply(w, out.String())
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.processTranslation(context.Background(), &p); err != nil || p.Status != "complete" {
		t.Fatalf("individual failure interrupted processing: %+v %v", p, err)
	}
	items, err := s.translations(doc.ID, blocks)
	if err != nil || items[0].Status != "failed" || items[1].Status != "complete" {
		t.Fatalf("lost partial translations: %+v %v", items, err)
	}
	response = request(t, s, "POST", "/api/documents/"+doc.ID+"/translations", strings.NewReader(`{"blockId":"`+blocks[0].ID+`"}`))
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	p, _ = s.Store.processing(doc.ID)
	if err := s.processTranslation(context.Background(), &p); err != nil || p.Status != "complete" {
		t.Fatalf("retry: %+v %v", p, err)
	}
	source, err := s.readTranslationSource(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	items, err = s.translations(doc.ID, source)
	if err != nil || items[0].Status != "complete" || calls != 3 {
		t.Fatalf("retry regenerated completed text: %d %v", calls, err)
	}
	// A source change invalidates only the affected paragraph's cached translation.
	blocks[0].Text = "Changed."
	changed, _ := s.translations(doc.ID, blocks)
	if changed[0].Status != "idle" || changed[1].Status != "complete" {
		t.Fatal("source versions mixed")
	}
	// Existing imports get an idle job without deleting translations.
	_, _ = s.Store.DB.Exec("DELETE FROM document_processing WHERE document_id=?", doc.ID)
	if err = s.Store.prepareManualEPUBProcessing(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.processing(doc.ID); err != nil {
		t.Fatal("legacy EPUB did not wait for a chapter request")
	}
}

func TestEPUBImagesPreserveReadingOrderAndStayLocal(t *testing.T) {
	blocks, err := epubTextBlocks("EPUB/chapters/a.xhtml", `<html><body><img src="../images/cover.jpg" alt="Cover"/><p>Text.</p><svg><image href="../images/chart.svg"/></svg><img src="https://example.com/remote.png"/><img src="../../../escape.png"/></body></html>`)
	if err != nil || len(blocks) != 3 {
		t.Fatalf("%+v %v", blocks, err)
	}
	if blocks[0].Image != "EPUB/images/cover.jpg" || blocks[0].Text != "Cover" || blocks[1].Text != "Text." || blocks[2].Image != "EPUB/images/chart.svg" {
		t.Fatalf("%+v", blocks)
	}
	if len(blocks.translationParagraphs()) != 1 {
		t.Fatal("images sent to text translator")
	}
}

func TestEPUBTranslatedAnnotationsPreserveSeparateRanges(t *testing.T) {
	s := testServer(t)
	var doc Document
	_ = json.Unmarshal(upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub")).Body.Bytes(), &doc)
	blocks, _ := s.readEPUBBlocks(doc.ID)
	path := "/api/documents/" + doc.ID + "/annotations"
	for i := 0; i < 2; i++ {
		var loc map[string]any
		raw, _ := json.Marshal(blocks[0].Location)
		_ = json.Unmarshal(raw, &loc)
		loc["translation"] = map[string]any{"blockId": blocks[0].ID, "sourceHash": "hash", "sentenceIndexes": []int{0}, "start": i, "end": i + 1, "ranges": []any{map[string]any{"blockId": blocks[0].ID, "sourceHash": "hash", "sentenceIndexes": []int{0}, "start": i, "end": i + 1, "quote": "译", "location": blocks[0].Location}}}
		body, _ := json.Marshal(map[string]any{"kind": "underline", "quote": "译", "note": "keep note", "location": loc, "color": "#e6b94c"})
		res := request(t, s, "POST", path, strings.NewReader(string(body)))
		if res.Code != 201 {
			t.Fatal(res.Body.String())
		}
	}
	// Opening the database also repairs old overlaps; translated selections must
	// remain distinct even when their original paragraph is identical.
	root := s.Store.Root
	s.Store.DB.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	s.Store = store
	res := request(t, s, "GET", path, nil)
	var notes []Annotation
	_ = json.Unmarshal(res.Body.Bytes(), &notes)
	if len(notes) != 2 {
		t.Fatalf("translated offsets merged: %s", res.Body.String())
	}
	for _, note := range notes {
		if note.Note != "keep note" || !strings.Contains(string(note.Location), `"translation"`) {
			t.Fatal("translation or note lost")
		}
	}
	if validLocation(json.RawMessage(`{"type":"epub","href":"a.xhtml","translation":{"ranges":[{"location":{"type":"epub","href":"../outside"}}]}}`), "epub") {
		t.Fatal("invalid nested source accepted")
	}
	if res = request(t, s, "DELETE", path+"/"+notes[0].ID, nil); res.Code != 204 {
		t.Fatal(res.Body.String())
	}
}
