package neoread

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyEPUBLocationConversion(t *testing.T) {
	blocks, err := epubTextBlocks("chapter.xhtml", "<html><body><p>阅读😀内容</p><p>second paragraph</p></body></html>")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks {
		raw, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": legacyBlockLocator(b), "quote": b.Text})
		converted, status := legacyEPUBLocation(raw, blocks)
		if status != "converted" {
			t.Fatalf("status %s", status)
		}
		var loc map[string]any
		json.Unmarshal(converted, &loc)
		if loc["blockId"] != b.ID || loc["start"] != float64(0) || loc["end"] != float64(utf16Length(b.Text)) {
			t.Fatalf("wrong position: %s", converted)
		}
		if _, ok := loc["locator"]; ok {
			t.Fatal("legacy field remains")
		}
		again, status := legacyEPUBLocation(converted, blocks)
		if status != "unchanged" || string(again) != string(converted) {
			t.Fatal("conversion is not idempotent")
		}
	}
}

func TestLegacyEPUBLocationPreservesAmbiguousAndMissingQuotes(t *testing.T) {
	blocks, _ := epubTextBlocks("chapter.xhtml", "<html><body><p>same</p><p>same</p></body></html>")
	for _, quote := range []string{"same", "missing"} {
		locator, _ := json.Marshal(map[string]any{"href": "chapter.xhtml", "type": "application/xhtml+xml", "text": map[string]string{"highlight": quote}})
		raw, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": string(locator), "quote": quote})
		result, status := legacyEPUBLocation(raw, blocks)
		if status == "converted" || string(raw) != string(result) {
			t.Fatalf("unsafe conversion: %s", result)
		}
	}
}

func TestLegacyEPUBLocationCrossParagraphAndUnicodeSlice(t *testing.T) {
	blocks, _ := epubTextBlocks("chapter.xhtml", "<html><body><p>阅读😀内容</p><p>second paragraph</p></body></html>")
	var first, last annotationLocator
	json.Unmarshal([]byte(legacyBlockLocator(blocks[0])), &first)
	json.Unmarshal([]byte(legacyBlockLocator(blocks[1])), &last)
	for _, tc := range []struct {
		start, end int
		quote      string
		endBlock   bool
	}{
		{2, 4, "😀", false},
		{0, last.Locations.TextRange.End, "阅读😀内容 second paragraph", true},
	} {
		loc, _ := json.Marshal(map[string]any{"href": "chapter.xhtml", "type": "application/xhtml+xml", "locations": map[string]any{"textRange": annotationTextRange{tc.start, tc.end}}})
		raw, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": string(loc), "quote": tc.quote})
		result, status := legacyEPUBLocation(raw, blocks)
		if status != "converted" {
			t.Fatal(status)
		}
		var out map[string]any
		json.Unmarshal(result, &out)
		if out["start"] != float64(tc.start) {
			t.Fatal(string(result))
		}
		if tc.endBlock && out["endBlockId"] != blocks[1].ID {
			t.Fatal(string(result))
		}
	}
}

func TestLegacyEPUBMigrationPreservesRecordsAndBackups(t *testing.T) {
	s := testServer(t)
	var doc Document
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	json.Unmarshal(response.Body.Bytes(), &doc)
	blocks, err := s.readEPUBBlocks(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	var block EPUBReadingBlock
	for _, b := range blocks {
		if b.Image == "" && b.Text != "" {
			block = b
			break
		}
	}
	location, _ := json.Marshal(map[string]any{"type": "epub", "href": block.Location.Href, "locator": legacyBlockLocator(block), "quote": block.Text})
	original := Annotation{ID: "legacy-note", DocumentID: doc.ID, Kind: "note", Location: location, Quote: block.Text, Note: "preserve note", Color: "#e6b94c", CreatedAt: now(), Tags: []string{"tag"}}
	body, _ := json.Marshal(original)
	if _, err = s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", original.ID, doc.ID, string(body)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = s.Store.migrateEPUBLocations(); err != nil {
			t.Fatal(err)
		}
	}
	var saved, backup string
	s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id=?", original.ID).Scan(&saved)
	s.Store.DB.QueryRow("SELECT body FROM epub_location_backups WHERE record_id=?", original.ID).Scan(&backup)
	if backup != string(body) {
		t.Fatal("original record not backed up")
	}
	var got Annotation
	json.Unmarshal([]byte(saved), &got)
	var loc map[string]any
	json.Unmarshal(got.Location, &loc)
	if loc["blockId"] != block.ID || loc["locator"] != nil {
		t.Fatalf("position not migrated: %s", got.Location)
	}
	got.Location = original.Location
	restored, _ := json.Marshal(got)
	if string(restored) != string(body) {
		t.Fatal("non-location fields changed")
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=?", doc.ID).Scan(&count)
	if count != 1 {
		t.Fatal("record count changed")
	}
}

func TestLegacyEPUBDOMRangeAndNestedReferences(t *testing.T) {
	source := "<html><body><p>same same</p></body></html>"
	blocks, _ := epubTextBlocks("chapter.xhtml", source)
	var old map[string]any
	json.Unmarshal([]byte(legacyBlockLocator(blocks[0])), &old)
	locations := old["locations"].(map[string]any)
	delete(locations, "textRange")
	dom := locations["domRange"].(map[string]any)
	dom["start"].(map[string]any)["charOffset"] = 5
	dom["end"].(map[string]any)["charOffset"] = 9
	encoded, _ := json.Marshal(old)
	loc := map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": string(encoded), "quote": "same"}
	raw, _ := json.Marshal(map[string]any{"readingLocation": loc, "references": []any{map[string]any{"location": loc}}, "content": "{\"type\":\"epub\",\"locator\":\"do not parse\"}"})
	output, n, failed := migrateEPUBPositionJSON(raw, blocks, map[string]string{"chapter.xhtml": source})
	if n != 2 || failed != 0 {
		t.Fatalf("converted=%d unresolved=%d", n, failed)
	}
	var result map[string]any
	json.Unmarshal(output, &result)
	position := result["readingLocation"].(map[string]any)
	if position["start"] != float64(5) || position["end"] != float64(9) || position["locator"] != nil {
		t.Fatal(string(output))
	}
	if result["content"] != "{\"type\":\"epub\",\"locator\":\"do not parse\"}" {
		t.Fatal("message content changed")
	}
}

func legacyBlockLocator(b EPUBReadingBlock) string {
	locations := map[string]any{}
	if b.legacy != nil {
		locations["textRange"] = annotationTextRange{b.legacy.Start, b.legacy.End}
		locations["domRange"] = map[string]any{"start": b.legacy.DOMStart, "end": b.legacy.DOMEnd}
	}
	encoded, _ := json.Marshal(map[string]any{"href": b.Location.Href, "type": "application/xhtml+xml", "locations": locations, "text": map[string]string{"highlight": b.Text}})
	return string(encoded)
}

func TestLegacyEPUBMigrationRollbackAndRetry(t *testing.T) {
	s := testServer(t)
	var doc Document
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	json.Unmarshal(response.Body.Bytes(), &doc)
	blocks, err := s.readEPUBBlocks(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	b := blocks[0]
	location, _ := json.Marshal(map[string]any{"type": "epub", "href": b.Location.Href, "locator": legacyBlockLocator(b), "quote": b.Text})
	original, _ := json.Marshal(Annotation{ID: "rollback", DocumentID: doc.ID, Kind: "note", Location: location, Note: "keep"})
	if _, err = s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", "rollback", doc.ID, string(original)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.DB.Exec(`CREATE TRIGGER fail_epub_migration BEFORE UPDATE ON annotations BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.migrateEPUBLocations(); err == nil {
		t.Fatal("expected transaction failure")
	}
	var saved string
	s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id='rollback'").Scan(&saved)
	if saved != string(original) {
		t.Fatal("failed migration changed record")
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM epub_location_backups WHERE record_id='rollback'").Scan(&count)
	if count != 0 {
		t.Fatal("backup escaped rolled-back transaction")
	}
	s.Store.DB.Exec("DROP TRIGGER fail_epub_migration")
	if err = s.Store.migrateEPUBLocations(); err != nil {
		t.Fatal(err)
	}
	s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id='rollback'").Scan(&saved)
	if saved == string(original) {
		t.Fatal("retry did not convert")
	}
}

func TestLegacyEPUBQuoteAcrossParagraphsAndUnresolvedStatus(t *testing.T) {
	blocks, _ := epubTextBlocks("chapter.xhtml", "<html><body><p>one two 😀</p><p>three four</p></body></html>")
	makeLocation := func(quote string) json.RawMessage {
		locator, _ := json.Marshal(map[string]any{"href": "chapter.xhtml", "type": "application/xhtml+xml", "text": map[string]string{"highlight": quote}})
		raw, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": string(locator)})
		return raw
	}
	output, n, failed := migrateEPUBPositionJSON(makeLocation("two  😀\nthree"), blocks)
	if n != 1 || failed != 0 {
		t.Fatalf("%d %d %s", n, failed, output)
	}
	var loc map[string]any
	json.Unmarshal(output, &loc)
	if loc["blockId"] != blocks[0].ID || loc["endBlockId"] != blocks[1].ID || loc["start"] != float64(4) || loc["end"] != float64(5) {
		t.Fatal(string(output))
	}
	unresolved, n, failed := migrateEPUBPositionJSON(makeLocation("missing"), blocks)
	loc = nil
	json.Unmarshal(unresolved, &loc)
	if n != 0 || failed != 1 || loc["unresolved"] != true || loc["locator"] == nil {
		t.Fatal(string(unresolved))
	}
	again, n, failed := migrateEPUBPositionJSON(unresolved, blocks)
	if n != 0 || failed != 1 || string(again) != string(unresolved) {
		t.Fatal("repeated failed migration changed data")
	}
	recovered, _ := epubTextBlocks("chapter.xhtml", "<html><body><p>missing</p></body></html>")
	output, n, failed = migrateEPUBPositionJSON(unresolved, recovered)
	if n != 0 || failed != 1 || string(output) != string(unresolved) {
		t.Fatal("unresolved location was retried after source changed")
	}
	output, n, failed = migrateEPUBPositionJSON(makeLocation("missing"), recovered)
	loc = nil
	json.Unmarshal(output, &loc)
	if n != 1 || failed != 0 || loc["unresolved"] != nil || loc["locator"] != nil {
		t.Fatal(string(output))
	}
}

func TestLegacyEPUBMigrationPreservesUnresolvableAnnotations(t *testing.T) {
	s := testServer(t)
	var doc Document
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	json.Unmarshal(response.Body.Bytes(), &doc)
	blocks, err := s.readEPUBBlocks(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	locator, _ := json.Marshal(map[string]any{"href": blocks[0].Location.Href, "type": "application/xhtml+xml", "text": map[string]string{"highlight": "THIS TEXT DOES NOT EXIST IN THE BOOK"}})
	loc, _ := json.Marshal(map[string]any{"type": "epub", "href": blocks[0].Location.Href, "locator": string(locator)})
	body, _ := json.Marshal(Annotation{ID: "unresolvable", DocumentID: doc.ID, Kind: "note", Location: loc, Quote: "preserve this quote", Note: "preserve this note"})
	if _, err = s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", "unresolvable", doc.ID, string(body)); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.migrateEPUBLocations(); err != nil {
		t.Fatal(err)
	}
	var backup string
	if err = s.Store.DB.QueryRow("SELECT body FROM epub_location_backups WHERE record_id='unresolvable'").Scan(&backup); err != nil || backup != string(body) {
		t.Fatal("original backup lost", err)
	}
	// A later read and startup must never retry, even if the book disappears.
	if err = os.RemoveAll(filepath.Join(s.Store.Root, "cache", doc.ID)); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.migrateEPUBLocations(); err != nil {
		t.Fatal(err)
	}
	r := request(t, s, "GET", "/api/documents/"+doc.ID+"/annotations", nil)
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	var annotations []Annotation
	if err = json.Unmarshal(r.Body.Bytes(), &annotations); err != nil || len(annotations) != 1 {
		t.Fatalf("annotations: %s, error: %v", r.Body.String(), err)
	}
	a := annotations[0]
	if a.ID != "unresolvable" || a.Note != "preserve this note" || a.Quote != "preserve this quote" {
		t.Fatalf("annotation content changed: %+v", a)
	}
	var position map[string]any
	if err = json.Unmarshal(a.Location, &position); err != nil || position["unresolved"] != true || position["locator"] != string(locator) {
		t.Fatalf("unresolved location lost: %s, error: %v", a.Location, err)
	}
}

func TestEPUBParagraphAPIExcludesLegacyMetadata(t *testing.T) {
	blocks, err := epubTextBlocks("chapter.xhtml", "<html><body><p>one 😀 two</p></body></html>")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(blocks)
	var payload []map[string]any
	json.Unmarshal(raw, &payload)
	loc := payload[0]["location"].(map[string]any)
	if loc["locator"] != nil || loc["blockId"] != blocks[0].ID || loc["end"] != float64(10) {
		t.Fatal(string(raw))
	}
	// Preserve the exact pre-migration ID recipe and its serialized point fields.
	b := blocks[0]
	key, _ := json.Marshal([]any{b.Location.Href, b.legacy.DOMStart, b.legacy.DOMEnd})
	sum := sha256.Sum256(key)
	if b.ID != "e-"+hex.EncodeToString(sum[:16]) {
		t.Fatal("paragraph ID recipe changed")
	}
}

func TestEPUBMigrationRepairsMixedSourceExcerpt(t *testing.T) {
	blocks, _ := epubTextBlocks("chapter.xhtml", "<html><body><p>Program is parsed.</p><p>Bytecode is evaluated.</p></body></html>")
	mixed := "Program is parsed.\n程序被解析。\nBytecode is evaluated."
	old, _ := json.Marshal(map[string]any{"href": "chapter.xhtml", "type": "application/xhtml+xml", "locations": map[string]any{"textRange": map[string]int{"start": blocks[0].legacy.Start, "end": blocks[1].legacy.End}}, "text": map[string]string{"highlight": mixed}})
	legacy, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "locator": string(old), "quote": mixed})
	converted, status := legacyEPUBLocation(legacy, blocks)
	if status != "converted" {
		t.Fatal(status)
	}
	for _, location := range []json.RawMessage{converted, json.RawMessage(jsonText(map[string]any{"type": "epub", "href": "chapter.xhtml", "blockId": blocks[0].ID, "endBlockId": blocks[1].ID, "start": 0, "end": utf16Length(blocks[1].Text), "quote": mixed}))} {
		a := Annotation{Location: location, Quote: mixed, Note: "用户笔记", Color: "#e6b94c"}
		if !repairEPUBAnnotationQuote(&a, blocks) || a.Quote != "Program is parsed. Bytecode is evaluated." || a.Note != "用户笔记" || a.Color != "#e6b94c" {
			t.Fatalf("incorrect repair: %+v", a)
		}
		if repairEPUBAnnotationQuote(&a, blocks) {
			t.Fatal("repair not idempotent")
		}
		var loc map[string]any
		json.Unmarshal(location, &loc)
		loc["translation"] = map[string]any{"blockId": blocks[0].ID, "start": 0, "end": 3}
		raw, _ := json.Marshal(loc)
		translated := Annotation{Location: raw, Quote: "程序被解析。"}
		if repairEPUBAnnotationQuote(&translated, blocks) || translated.Quote != "程序被解析。" {
			t.Fatal("source repair changed translation")
		}
	}
}

func TestEPUBMigrationQuoteRepairSkipsImageText(t *testing.T) {
	for _, alt := range []string{"Chart description", ""} {
		t.Run("alt="+alt, func(t *testing.T) {
			blocks, err := epubTextBlocks("chapter.xhtml", `<html><body><p>one two three</p><img src="chart.png" alt="`+alt+`"/><p>four five six</p></body></html>`)
			if err != nil || len(blocks) != 3 || blocks[1].Image == "" {
				t.Fatalf("image fixture: %+v, %v", blocks, err)
			}
			location, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "blockId": blocks[0].ID, "endBlockId": blocks[2].ID, "start": 4, "end": 9, "quote": "mixed source and translation"})
			a := Annotation{Location: location, Quote: "mixed source and translation", Note: "keep note", Color: "#e6b94c"}
			if !repairEPUBAnnotationQuote(&a, blocks) || a.Quote != "two three four five" || a.Note != "keep note" || a.Color != "#e6b94c" {
				t.Fatalf("repaired annotation: %+v", a)
			}
			var loc map[string]any
			if err := json.Unmarshal(a.Location, &loc); err != nil || loc["quote"] != a.Quote || loc["blockId"] != blocks[0].ID || loc["endBlockId"] != blocks[2].ID || loc["start"] != float64(4) || loc["end"] != float64(9) {
				t.Fatalf("repaired location: %s, %v", a.Location, err)
			}
			if repairEPUBAnnotationQuote(&a, blocks) {
				t.Fatal("repeated repair changed quote")
			}
		})
	}
}

func TestEPUBMigrationCompletionSkipsLaterReadsAndStarts(t *testing.T) {
	s := testServer(t)
	var doc Document
	json.Unmarshal(upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub")).Body.Bytes(), &doc)
	if err := s.Store.migrateEPUBLocations(); err != nil {
		t.Fatal(err)
	}
	// Simulate an old writer after completion. Neither GET nor startup may migrate again.
	body := jsonText(Annotation{ID: "late", DocumentID: doc.ID, Kind: "highlight", Location: json.RawMessage(`{"type":"epub","href":"missing.xhtml","locator":"invalid"}`), Quote: "unchanged"})
	if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", "late", doc.ID, body); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.migrateEPUBLocations(); err != nil {
		t.Fatal(err)
	}
	if r := request(t, s, "GET", "/api/documents/"+doc.ID+"/annotations", nil); r.Code != 200 {
		t.Fatal(r.Code)
	}
	var saved string
	s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id='late'").Scan(&saved)
	if saved != body {
		t.Fatal("completed migration retried")
	}
}
