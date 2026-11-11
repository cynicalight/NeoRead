package neoread

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"sync"
	"testing"
)

func TestUnderlineMergeAPI(t *testing.T) {
	s := testServer(t)
	uploaded := upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf"))
	var doc Document
	if err := json.Unmarshal(uploaded.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	path := "/api/documents/" + doc.ID + "/annotations"
	save := func(x, width float64, quote string) Annotation {
		body, _ := json.Marshal(map[string]any{"kind": "underline", "quote": quote, "color": "#e6b94c", "location": map[string]any{"type": "pdf", "page": 1, "rects": []map[string]float64{{"x": x, "y": 0.2, "width": width, "height": 0.02}}}})
		w := request(t, s, "POST", path, bytes.NewReader(body))
		if w.Code != 201 {
			t.Fatalf("save: %d %s", w.Code, w.Body.String())
		}
		var a Annotation
		if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	first := save(0.1, 0.3, "reading, describe")
	duplicate := save(0.1, 0.3, "reading, describe")
	if first.ID != duplicate.ID {
		t.Fatalf("duplicate underline created a new record: %s != %s", first.ID, duplicate.ID)
	}
	save(0.12, 0.04, "rea")
	merged := save(0.3, 0.3, "describe the question")
	var items []Annotation
	w := request(t, s, "GET", path, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("overlapping underlines remain: %d", len(items))
	}
	if merged.ID != first.ID || items[0].Quote != "reading, describe the question" {
		t.Fatalf("wrong merged record: %+v", items[0])
	}
	var location annotationPDFLocation
	json.Unmarshal(items[0].Location, &location)
	if len(location.Rects) != 1 || math.Abs(location.Rects[0].X-0.1) > 1e-8 || math.Abs(location.Rects[0].Width-0.5) > 1e-8 {
		t.Fatalf("wrong union: %+v", location.Rects)
	}
}

func TestHighlightMergeAPI(t *testing.T) {
	s := testServer(t)
	uploaded := upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf"))
	var doc Document
	if err := json.Unmarshal(uploaded.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	path := "/api/documents/" + doc.ID + "/annotations"
	save := func(x, width float64, quote string) Annotation {
		body, _ := json.Marshal(map[string]any{"kind": "highlight", "quote": quote, "color": "#e6b94c", "location": map[string]any{"type": "pdf", "page": 1, "rects": []annotationRect{{X: x, Y: 0.2, Width: width, Height: 0.02}}}})
		w := request(t, s, "POST", path, bytes.NewReader(body))
		if w.Code != 201 {
			t.Fatalf("save: %d %s", w.Code, w.Body.String())
		}
		var a Annotation
		if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	first := save(0.1, 0.3, "one two")
	duplicate := save(0.1, 0.3, "one two")
	if duplicate.ID != first.ID {
		t.Fatalf("duplicate highlight created a record: %s != %s", first.ID, duplicate.ID)
	}
	merged := save(0.3, 0.3, "two three")
	w := request(t, s, "GET", path, nil)
	var items []Annotation
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || merged.ID != first.ID || items[0].Quote != "one two three" {
		t.Fatalf("highlights not merged: %+v", items)
	}
}

func TestSourceLinkedHighlightMerge(t *testing.T) {
	a := pdfUnderline("a", []annotationRect{{0.1, 0.2, 0.3, 0.02}}, "one two")
	a.Kind = "highlight"
	b := pdfUnderline("b", []annotationRect{{0.3, 0.2, 0.3, 0.02}}, "two three")
	b.Kind = "highlight"
	link := func(a Annotation, part string) Annotation {
		var location map[string]json.RawMessage
		json.Unmarshal(a.Location, &location)
		location["sentenceLink"], _ = json.Marshal(map[string]any{"origin": "source", "parts": []map[string]string{{"blockId": part, "sourceHash": "hash", "source": part, "target": part}}})
		a.Location, _ = json.Marshal(location)
		return a
	}
	a, b = link(a, "one"), link(b, "two")
	merged, ok := mergeAnnotationMark(a, b)
	if !ok || merged.Quote != "one two three" {
		t.Fatalf("source highlights not merged: %+v %v", merged, ok)
	}
	var location struct {
		SentenceLink struct {
			Origin string            `json:"origin"`
			Parts  []json.RawMessage `json:"parts"`
		} `json:"sentenceLink"`
	}
	if err := json.Unmarshal(merged.Location, &location); err != nil || location.SentenceLink.Origin != "source" || len(location.SentenceLink.Parts) != 2 {
		t.Fatalf("source links lost: %+v %v", location, err)
	}
	duplicate, ok := mergeAnnotationMark(merged, link(b, "two"))
	if !ok {
		t.Fatal("repeated source highlight was not deduplicated")
	}
	json.Unmarshal(duplicate.Location, &location)
	if len(location.SentenceLink.Parts) != 2 {
		t.Fatalf("duplicate source link: %+v", location.SentenceLink)
	}
	s := testServer(t)
	var doc Document
	json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc)
	a.DocumentID, b.DocumentID = doc.ID, doc.ID
	if _, err := s.Store.saveAnnotation(a); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Store.saveAnnotation(b)
	if err != nil || saved.ID != a.ID {
		t.Fatalf("linked highlights saved separately: %+v %v", saved, err)
	}
	json.Unmarshal(saved.Location, &location)
	if len(location.SentenceLink.Parts) != 2 {
		t.Fatalf("saved source links lost: %+v", location.SentenceLink)
	}
	plain := pdfUnderline("plain", []annotationRect{{0.3, 0.2, 0.3, 0.02}}, "two three")
	plain.Kind = "highlight"
	if _, ok := mergeAnnotationMark(a, plain); ok {
		t.Fatal("merged linked and unlinked highlights")
	}
}

func TestEPUBHighlightMerge(t *testing.T) {
	a := epubUnderline("a", 0, 7, "one two")
	b := epubUnderline("b", 4, 13, "two three")
	a.Kind, b.Kind = "highlight", "highlight"
	merged, ok := mergeAnnotationMark(a, b)
	if !ok || merged.Quote != "one two three" {
		t.Fatalf("EPUB highlights not merged: %+v %v", merged, ok)
	}
	var location struct{ Start, End int }
	json.Unmarshal(merged.Location, &location)
	if location.Start != 0 || location.End != 13 {
		t.Fatalf("wrong range: %+v", location)
	}

	duplicate, ok := mergeAnnotationMark(merged, merged)
	if !ok || duplicate.Quote != merged.Quote {
		t.Fatal("repeated EPUB highlight was not deduplicated")
	}
}

func TestHighlightRestartPreservesHistoricalDuplicates(t *testing.T) {
	s := testServer(t)
	var doc Document
	json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc)
	for _, id := range []string{"first", "duplicate"} {
		a := pdfUnderline(id, []annotationRect{{0.1, 0.2, 0.3, 0.02}}, "same sentence")
		a.Kind, a.DocumentID = "highlight", doc.ID
		body, _ := json.Marshal(a)
		if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", id, doc.ID, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	root := s.Store.Root
	s.Store.DB.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	var count int
	store.DB.QueryRow("SELECT COUNT(*) FROM annotations WHERE document_id=?", doc.ID).Scan(&count)
	if count != 2 {
		t.Fatalf("historical highlight duplicates changed: %d", count)
	}
}

func pdfUnderline(id string, rects []annotationRect, quote string) Annotation {
	location, _ := json.Marshal(annotationPDFLocation{Type: "pdf", Page: 1, Rects: rects})
	return Annotation{ID: id, DocumentID: "doc", Kind: "underline", Location: location, Quote: quote, Color: "#e6b94c", CreatedAt: now()}
}
func TestUnderlineMergeBoundaries(t *testing.T) {
	a := pdfUnderline("a", []annotationRect{{0.1, 0.2, 0.3, 0.02}}, "阅读原文")
	for _, kind := range []string{"note", "highlight", "bookmark"} {
		b := a
		b.Kind = kind
		if _, ok := mergeAnnotationMark(a, b); ok {
			t.Fatalf("merged %s into underline", kind)
		}
	}
	separate := []Annotation{
		pdfUnderline("disjoint", []annotationRect{{0.6, 0.2, 0.1, 0.02}}, "原文"),
		pdfUnderline("touching", []annotationRect{{0.4, 0.2, 0.1, 0.02}}, "原文"),
		pdfUnderline("other-line", []annotationRect{{0.1, 0.3, 0.3, 0.02}}, "阅读原文"),
	}
	otherPage := a
	otherPage.Location = json.RawMessage(`{"type":"pdf","page":2,"rects":[{"x":0.1,"y":0.2,"width":0.3,"height":0.02}]}`)
	otherDoc := a
	otherDoc.DocumentID = "other"
	separate = append(separate, otherPage, otherDoc)
	for _, b := range separate {
		if _, ok := mergeAnnotationMark(a, b); ok {
			t.Fatalf("merged separate ranges: %+v", b)
		}
	}
	b := pdfUnderline("b", []annotationRect{{0.3, 0.2001, 0.3, 0.02}}, "原文内容")
	merged, ok := mergeAnnotationMark(a, b)
	if !ok || merged.Quote != "阅读原文内容" {
		t.Fatalf("unicode overlap: %+v %v", merged, ok)
	}
}
func TestUnderlineMergeAcrossLines(t *testing.T) {
	a := pdfUnderline("a", []annotationRect{{0.1, 0.2, 0.6, 0.02}, {0.1, 0.3, 0.2, 0.02}}, "Before reading\nUse the outline")
	b := pdfUnderline("b", []annotationRect{{0.2, 0.3, 0.5, 0.02}, {0.1, 0.4, 0.4, 0.02}}, "outline to inspect\nSelect a sentence")
	merged, ok := mergeAnnotationMark(a, b)
	if !ok {
		t.Fatal("cross-line overlap not merged")
	}
	var location annotationPDFLocation
	json.Unmarshal(merged.Location, &location)
	if len(location.Rects) != 3 || math.Abs(location.Rects[1].Width-0.6) > 1e-8 {
		t.Fatalf("lines or coverage lost: %+v", location.Rects)
	}
	if merged.Quote != "Before reading Use the outline to inspect Select a sentence" {
		t.Fatalf("wrong quote: %s", merged.Quote)
	}
}

func TestUnderlineMergeRepeatedPhrase(t *testing.T) {
	a := pdfUnderline("a", []annotationRect{{0.1, 0.2, 0.2, 0.02}}, "word word")
	b := pdfUnderline("b", []annotationRect{{0.2, 0.2, 0.2, 0.02}}, "word word")
	merged, ok := mergeAnnotationMark(a, b)
	if !ok || merged.Quote != "word word word" {
		t.Fatalf("repeated words lost: %q", merged.Quote)
	}
}
func TestUnderlineBridgeAndRestartPreservesHistoricalDuplicates(t *testing.T) {
	s := testServer(t)
	var doc Document
	json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc)
	insert := func(a Annotation) {
		a.DocumentID = doc.ID
		body, _ := json.Marshal(a)
		if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", a.ID, doc.ID, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	left := pdfUnderline("left", []annotationRect{{0.1, 0.2, 0.2, 0.02}}, "one two")
	right := pdfUnderline("right", []annotationRect{{0.5, 0.2, 0.2, 0.02}}, "four five")
	bridge := pdfUnderline("bridge", []annotationRect{{0.2, 0.2, 0.4, 0.02}}, "two three four")
	left.Note = "keep this"
	right.Note = "and this"
	insert(left)
	insert(right)
	bridge.DocumentID = doc.ID
	result, err := s.Store.saveAnnotation(bridge)
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "left" || result.Quote != "one two three four five" || len(result.ReplacedIDs) != 1 || result.ReplacedIDs[0] != "right" || result.Note != "keep this\n\nand this" {
		t.Fatalf("wrong bridge result: %+v", result)
	}
	// Simulate historical duplicates written by the old insertion-only API.
	duplicate := result.Annotation
	duplicate.ID = "old-duplicate"
	insert(duplicate)
	note := left
	note.ID = "note"
	note.Kind = "note"
	note.Note = "Do not remove"
	insert(note)
	root := s.Store.Root
	s.Store.DB.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	var startupCount int
	store.DB.QueryRow("SELECT count(*) FROM annotations").Scan(&startupCount)
	if startupCount != 3 {
		t.Fatalf("startup should preserve historical duplicates: %d", startupCount)
	}
	items, err := store.DB.Query("SELECT body FROM annotations ORDER BY rowid")
	if err != nil {
		t.Fatal(err)
	}
	var records []Annotation
	for items.Next() {
		var body []byte
		items.Scan(&body)
		var a Annotation
		json.Unmarshal(body, &a)
		records = append(records, a)
	}
	items.Close()
	if len(records) != 3 || records[0].ID != "left" || records[2].Note != "Do not remove" {
		t.Fatalf("legacy repair damaged records: %+v", records)
	}
	var count int
	store.DB.QueryRow("SELECT COUNT(*) FROM annotations").Scan(&count)
	if count != 3 {
		t.Fatalf("historical duplicates changed: %d", count)
	}
}
func TestConcurrentUnderlineSaves(t *testing.T) {
	s := testServer(t)
	var doc Document
	json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc)
	var wg sync.WaitGroup
	failures := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a := pdfUnderline(id(), []annotationRect{{0.1, 0.2, 0.2, 0.02}}, "same text")
			a.DocumentID = doc.ID
			_, err := s.Store.saveAnnotation(a)
			failures <- err
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	s.Store.DB.QueryRow("SELECT COUNT(*) FROM annotations WHERE document_id=?", doc.ID).Scan(&count)
	if count != 1 {
		t.Fatalf("concurrent duplicate records: %d", count)
	}
}
func epubUnderline(id string, start, end int, quote string) Annotation {
	location, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "blockId": "test-block", "start": start, "end": end})
	return Annotation{ID: id, DocumentID: "doc", Kind: "underline", Location: location, Quote: quote}
}
func TestEPUBUnderlineUnion(t *testing.T) {
	a := epubUnderline("a", 0, 7, "one two")
	b := epubUnderline("b", 4, 13, "two three")
	merged, ok := mergeAnnotationMark(a, b)
	if !ok || merged.Quote != "one two three" {
		t.Fatalf("EPUB merge: %+v %v", merged, ok)
	}
	var location struct{ Start, End int }
	json.Unmarshal(merged.Location, &location)
	if location.Start != 0 || location.End != 13 {
		t.Fatalf("wrong range: %+v", location)
	}

	contained := epubUnderline("c", 4, 7, "two")
	merged, ok = mergeAnnotationMark(a, contained)
	if !ok || merged.Quote != a.Quote {
		t.Fatal("contained EPUB underline changed quote")
	}
	separate := epubUnderline("d", 7, 13, "three")
	if _, ok = mergeAnnotationMark(a, separate); ok {
		t.Fatal("merged touching EPUB ranges")
	}

}

func TestLinkedAndTranslatedUnderlinesKeepTheirAnchors(t *testing.T) {
	for _, field := range []string{"translation", "sentenceLink"} {
		a := pdfUnderline("a", []annotationRect{{0.1, 0.2, 0.2, 0.02}}, "first")
		b := pdfUnderline("b", []annotationRect{{0.1, 0.2, 0.2, 0.02}}, "second")
		var location map[string]json.RawMessage
		if err := json.Unmarshal(b.Location, &location); err != nil {
			t.Fatal(err)
		}
		location[field] = json.RawMessage(`{"blockId":"p1-b1"}`)
		b.Location, _ = json.Marshal(location)
		if _, ok := mergeAnnotationMark(a, b); ok {
			t.Fatalf("merged and lost %s anchor", field)
		}
		if _, ok := mergeAnnotationMark(b, a); ok {
			t.Fatalf("merged incompatible %s anchors", field)
		}
	}
}

func TestSourceLinkedMarkDocumentOrder(t *testing.T) {
	type part struct {
		BlockID       string `json:"blockId"`
		SourceHash    string `json:"sourceHash"`
		SentenceIndex int    `json:"sentenceIndex"`
		Source        string `json:"source"`
		Target        string `json:"target"`
	}
	// Block IDs are deliberately not in lexical document order.
	parts := []part{{"z-first", "hash", 0, "A", "甲"}, {"m-middle", "hash", 0, "B", "乙"}, {"a-last", "hash", 0, "C", "丙"}}
	for _, format := range []string{"pdf", "epub"} {
		for _, kind := range []string{"highlight", "underline"} {
			for _, tc := range []struct {
				name               string
				oldStart, oldEnd   int
				newStart, newEnd   int
				oldParts, newParts []int
			}{
				{"extend backwards", 2, 5, 0, 3, []int{1, 2}, []int{0, 1}},
				{"contain older selection", 2, 3, 0, 5, []int{1}, []int{0, 1, 2}},
				{"extend forwards", 0, 3, 2, 5, []int{0, 1}, []int{1, 2}},
				{"same start", 0, 3, 0, 5, []int{0, 1}, []int{0, 1, 2}},
				{"fill middle link", 0, 5, 2, 3, []int{0, 2}, []int{1}},
			} {
				t.Run(format+"/"+kind+"/"+tc.name, func(t *testing.T) {
					makeMark := func(id string, start, end int, indexes []int) Annotation {
						quote := "A B C"[start:end]
						a := pdfUnderline(id, []annotationRect{{.1 + float64(start)*.02, .2, float64(end-start) * .02, .02}}, quote)
						if format == "epub" {
							a = epubUnderline(id, start, end, quote)
						}
						a.Kind = kind
						var location map[string]json.RawMessage
						json.Unmarshal(a.Location, &location)
						selected := []part{}
						for _, index := range indexes {
							selected = append(selected, parts[index])
						}
						location["sentenceLink"], _ = json.Marshal(map[string]any{"origin": "source", "parts": selected})
						a.Location, _ = json.Marshal(location)
						return a
					}
					old := makeMark("old", tc.oldStart, tc.oldEnd, tc.oldParts)
					incoming := makeMark("new", tc.newStart, tc.newEnd, tc.newParts)
					merged, ok := mergeAnnotationMark(old, incoming)
					if !ok || merged.ID != old.ID || merged.Quote != "A B C" {
						t.Fatalf("merge: %+v, %v", merged, ok)
					}
					var location struct {
						SentenceLink struct{ Parts []part } `json:"sentenceLink"`
					}
					json.Unmarshal(merged.Location, &location)
					if !reflect.DeepEqual(location.SentenceLink.Parts, parts) {
						t.Fatalf("wrong source/translation order or first navigation block: %+v", location.SentenceLink.Parts)
					}
				})
			}
		}
	}
}

func TestSourceSentenceLinkOrderBoundaries(t *testing.T) {
	part := func(block string, index int) map[string]any {
		// Identical excerpts at different sentence indexes are different links.
		return map[string]any{"blockId": block, "sourceHash": "h", "sentenceIndex": index, "source": "Repeated.", "target": "重复。"}
	}
	mark := func(parts ...map[string]any) Annotation {
		location, _ := json.Marshal(map[string]any{"sentenceLink": map[string]any{"origin": "source", "parts": parts}})
		return Annotation{Location: location}
	}
	t.Run("sentence indexes disambiguate equal selection boundaries", func(t *testing.T) {
		linked, ok := mergeSourceSentenceLinks(mark(part("block", 10)), mark(part("block", 2)), "Repeated. Repeated.")
		if !ok {
			t.Fatal("could not order sentences in the same block")
		}
		var link struct {
			Parts []struct {
				Index int `json:"sentenceIndex"`
			} `json:"parts"`
		}
		json.Unmarshal(linked, &link)
		if len(link.Parts) != 2 || link.Parts[0].Index != 2 || link.Parts[1].Index != 10 {
			t.Fatalf("repeated excerpts lost or numeric order reversed: %s", linked)
		}
	})
	t.Run("shared sentences order partial excerpts", func(t *testing.T) {
		a, b, c := part("z-first", 0), part("middle", 0), part("a-last", 0)
		linked, ok := mergeSourceSentenceLinks(mark(b, c), mark(a, b), "peated.")
		if !ok {
			t.Fatal("could not join ordered snapshots at their shared sentence")
		}
		var link struct {
			Parts []map[string]any `json:"parts"`
		}
		json.Unmarshal(linked, &link)
		if len(link.Parts) != 3 || link.Parts[0]["blockId"] != "z-first" || link.Parts[2]["blockId"] != "a-last" {
			t.Fatalf("partial excerpt reordered: %s", linked)
		}
	})
	t.Run("extracted anchors order sparse links", func(t *testing.T) {
		a, b := part("z-first", 0), part("a-last", 0)
		a["anchor"], b["anchor"] = "First sentence.", "Last sentence."
		linked, ok := mergeSourceSentenceLinks(mark(b), mark(a), "First\nsen\u00adtence. Last sentence.")
		if !ok {
			t.Fatal("could not order links by extracted anchors")
		}
		var link struct {
			Parts []map[string]any `json:"parts"`
		}
		json.Unmarshal(linked, &link)
		if len(link.Parts) != 2 || link.Parts[0]["blockId"] != "z-first" {
			t.Fatalf("extracted anchors ignored: %s", linked)
		}
	})
	t.Run("ambiguous blocks stay separate", func(t *testing.T) {
		if _, ok := mergeSourceSentenceLinks(mark(part("a", 0)), mark(part("z", 0)), "Repeated. Repeated."); ok {
			t.Fatal("invented an order for unrelated block IDs at equal boundaries")
		}
	})
	t.Run("contradictory snapshots stay separate", func(t *testing.T) {
		a, b := part("a", 0), part("b", 0)
		if _, ok := mergeSourceSentenceLinks(mark(a, b), mark(b, a), "Repeated. Repeated."); ok {
			t.Fatal("merged contradictory sentence orders")
		}
	})
}

func TestMarkMetadataCompatibility(t *testing.T) {
	for _, kind := range []string{"highlight", "underline"} {
		for _, tc := range []struct {
			name   string
			change func(*Annotation)
			merge  bool
		}{
			{"different color", func(a *Annotation) { a.Color = "#5b9fe8" }, false},
			{"same color case", func(a *Annotation) { a.Color = "#E6B94C" }, true},
			{"different tags", func(a *Annotation) { a.Tags = []string{"question"} }, false},
			{"different tag order", func(a *Annotation) { a.Tags = []string{"important", "method"} }, true},
			{"linked answer", func(a *Annotation) { a.AnswerID = "answer" }, false},
			{"resolved state", func(a *Annotation) { a.Resolved = true }, false},
		} {
			t.Run(kind+"/"+tc.name, func(t *testing.T) {
				a := pdfUnderline("first", []annotationRect{{.1, .2, .3, .02}}, "one two")
				a.Kind, a.Tags = kind, []string{"method", "important"}
				b := a
				b.ID = "second"
				tc.change(&b)
				_, ok := mergeAnnotationMark(a, b)
				if ok != tc.merge {
					t.Fatalf("merge = %v, want %v", ok, tc.merge)
				}
			})
		}
	}
}

func TestHighlightRestartPreservesClassification(t *testing.T) {
	s := testServer(t)
	var doc Document
	json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc)
	expected := map[string]string{}
	for _, item := range []struct{ id, color, tag string }{
		{"first", "#e6b94c", "method"},
		{"different-color", "#5b9fe8", "method"},
		{"different-tag", "#e6b94c", "question"},
		{"duplicate", "#e6b94c", "method"},
	} {
		a := pdfUnderline(item.id, []annotationRect{{.1, .2, .3, .02}}, "same sentence")
		a.Kind, a.DocumentID, a.Color, a.Tags = "highlight", doc.ID, item.color, []string{item.tag}
		a.Note = "Keep the note"
		body, _ := json.Marshal(a)
		if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,?,?)", a.ID, doc.ID, string(body)); err != nil {
			t.Fatal(err)
		}
		expected[item.id] = string(body)
	}
	root := s.Store.Root
	s.Store.DB.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	actual, err := annotationSnapshot(store.DB, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(actual) != len(expected) {
		t.Fatalf("startup lost highlight classifications: %v", actual)
	}
	for id, body := range expected {
		var want, got Annotation
		json.Unmarshal([]byte(body), &want)
		json.Unmarshal([]byte(actual[id]), &got)
		if got.ID != id || got.Color != want.Color || !reflect.DeepEqual(got.Tags, want.Tags) || got.Note != want.Note || got.Quote != want.Quote {
			t.Fatalf("startup changed classification %s: %+v", id, got)
		}
	}
}
