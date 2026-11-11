package neoread

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestReflowHighlightMergeAPI(t *testing.T) {
	for _, translated := range []bool{false, true} {
		name := "source"
		if translated {
			name = "translation"
		}
		t.Run(name, func(t *testing.T) {
			s := testServer(t)
			var doc Document
			if err := json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc); err != nil {
				t.Fatal(err)
			}
			path := "/api/documents/" + doc.ID + "/annotations"
			var id string
			for _, mark := range []Annotation{reflowTestMark("a", "one two three", 0, 7, translated), reflowTestMark("b", "one two three", 4, 13, translated)} {
				body, _ := json.Marshal(mark)
				w := request(t, s, "POST", path, bytes.NewReader(body))
				if w.Code != 201 {
					t.Fatalf("save: %d %s", w.Code, w.Body.String())
				}
				var result Annotation
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if id != "" && (result.ID != id || result.Quote != "one two three") {
					t.Fatalf("not merged: %+v", result)
				}
				id = result.ID
			}
			var items []Annotation
			if err := json.Unmarshal(request(t, s, "GET", path, nil).Body.Bytes(), &items); err != nil || len(items) != 1 {
				t.Fatalf("items: %+v, %v", items, err)
			}
		})
	}
}

func reflowTestMark(id, text string, start, end int, translated bool) Annotation {
	part := map[string]any{"blockId": "a", "start": start, "end": end}
	quote := text[start:end]
	location := map[string]any{"type": "pdf", "page": 1}
	if translated {
		part["sourceHash"], part["targetText"], part["renderedText"], part["quote"], part["sentenceIndexes"] = "h", text, text, quote, []int{0}
		location["translation"] = map[string]any{"blockId": "a", "sourceHash": "h", "start": start, "end": end, "ranges": []any{part}}
	} else {
		part["source"], part["text"], part["page"] = quote, text, 1
		location["sourceAnchors"] = []any{part}
	}
	raw, _ := json.Marshal(location)
	return Annotation{ID: id, DocumentID: "d", Kind: "highlight", Color: "#ff0000", Quote: quote, Location: raw}
}

func TestReflowHighlightMerge(t *testing.T) {
	for _, tt := range []struct{ name, left, right string }{
		{"source", `{"type":"pdf","page":1,"sourceAnchors":[{"blockId":"a","source":"one two","page":1,"start":0,"end":7,"text":"one two three"}]}`, `{"type":"pdf","page":1,"sourceAnchors":[{"blockId":"a","source":"two three","page":1,"start":4,"end":13,"text":"one two three"}]}`},
		{"translation", `{"type":"pdf","page":1,"translation":{"blockId":"a","sourceHash":"h","start":0,"end":7,"ranges":[{"blockId":"a","sourceHash":"h","start":0,"end":7,"quote":"one two","targetText":"one two three"}]}}`, `{"type":"pdf","page":1,"translation":{"blockId":"a","sourceHash":"h","start":4,"end":13,"ranges":[{"blockId":"a","sourceHash":"h","start":4,"end":13,"quote":"two three","targetText":"one two three"}]}}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			a := Annotation{DocumentID: "d", Kind: "highlight", Quote: "one two", Location: json.RawMessage(tt.left)}
			b := Annotation{DocumentID: "d", Kind: "highlight", Quote: "two three", Location: json.RawMessage(tt.right)}
			merged, ok := mergeAnnotationMark(a, b)
			if !ok || merged.Quote != "one two three" {
				t.Fatalf("overlap not merged: ok=%v quote=%q", ok, merged.Quote)
			}
		})
	}
}

func TestReflowMarkSaveAndSafety(t *testing.T) {
	for _, translated := range []bool{false, true} {
		name := "source"
		if translated {
			name = "translation"
		}
		t.Run(name, func(t *testing.T) {
			s := testServer(t)
			var doc Document
			if err := json.Unmarshal(upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf")).Body.Bytes(), &doc); err != nil {
				t.Fatal(err)
			}
			save := func(mark Annotation) annotationSaveResult {
				mark.DocumentID = doc.ID
				result, err := s.Store.saveAnnotation(mark)
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			first := reflowTestMark("first", "word word word", 5, 14, translated)
			first.Note = "first note"
			save(first)
			duplicate := reflowTestMark("duplicate", "word word word", 5, 14, translated)
			if got := save(duplicate); got.ID != first.ID {
				t.Fatalf("duplicate: %+v", got)
			}
			extension := reflowTestMark("extension", "word word word", 0, 9, translated)
			extension.Note = "second note"
			got := save(extension)
			if got.ID != first.ID || got.Quote != "word word word" || got.Note != "first note\n\nsecond note" {
				t.Fatalf("backwards overlap: %+v", got)
			}
			other := reflowTestMark("other", "word word word", 0, 4, translated)
			other.Color = "#0000ff"
			if got := save(other); got.ID != other.ID {
				t.Fatalf("different color merged: %+v", got)
			}
		})
	}
}

func TestReflowMarkDoesNotMergeDistinctPositionsOrSnapshots(t *testing.T) {
	for _, translated := range []bool{false, true} {
		a := reflowTestMark("a", "word word", 0, 4, translated)
		b := reflowTestMark("b", "word word", 5, 9, translated)
		if _, ok := mergeAnnotationMark(a, b); ok {
			t.Fatal("separate occurrences merged")
		}
		c := reflowTestMark("c", "word other", 0, 4, translated)
		if _, ok := mergeAnnotationMark(a, c); ok {
			t.Fatal("different snapshots merged")
		}
	}
}

func TestReflowCrossParagraphMerge(t *testing.T) {
	makeMark := func(id, quote string, anchors ...map[string]any) Annotation {
		loc, _ := json.Marshal(map[string]any{"type": "pdf", "page": 1, "sourceAnchors": anchors})
		return Annotation{ID: id, DocumentID: "d", Kind: "highlight", Quote: quote, Location: loc}
	}
	anchor := func(id, text string, start, end int) map[string]any {
		return map[string]any{"blockId": id, "page": 1, "text": text, "source": text[start:end], "start": start, "end": end}
	}
	a := makeMark("a", "first middle", anchor("a", "first", 0, 5), anchor("b", "middle", 0, 6))
	b := makeMark("b", "middle last", anchor("b", "middle", 0, 6), anchor("c", "last", 0, 4))
	for _, pair := range [][2]Annotation{{a, b}, {b, a}} {
		merged, ok := mergeAnnotationMark(pair[0], pair[1])
		if !ok || merged.Quote != "first middle last" {
			t.Fatalf("merge: %v %+v", ok, merged)
		}
		var location struct {
			SourceAnchors []struct {
				BlockID string `json:"blockId"`
			} `json:"sourceAnchors"`
		}
		if err := json.Unmarshal(merged.Location, &location); err != nil || len(location.SourceAnchors) != 3 || location.SourceAnchors[0].BlockID != "a" || location.SourceAnchors[2].BlockID != "c" {
			t.Fatalf("anchors: %+v, %v", location, err)
		}
	}
}

func TestTranslationRenderedTextSurvivesEnrichment(t *testing.T) {
	a := reflowTestMark("a", "word word", 0, 4, true)
	a = enrichTranslationAnnotation(a, nil)
	parts, translated, _ := textMarkParts(a.Location)
	if !translated || len(parts) != 1 || parts[0].RenderedText != "word word" {
		t.Fatalf("lost rendered text: %s", a.Location)
	}
}

func TestReflowMergeUsesUTF16Offsets(t *testing.T) {
	makeMark := func(id, quote string, start, end int) Annotation {
		anchor := map[string]any{"blockId": "a", "page": 1, "text": "😀x😀", "source": quote, "start": start, "end": end}
		loc, _ := json.Marshal(map[string]any{"type": "pdf", "page": 1, "sourceAnchors": []any{anchor}})
		return Annotation{ID: id, DocumentID: "d", Kind: "highlight", Quote: quote, Location: loc}
	}
	got, ok := mergeAnnotationMark(makeMark("a", "😀x", 0, 3), makeMark("b", "x😀", 2, 5))
	if !ok || got.Quote != "😀x😀" {
		t.Fatalf("UTF-16 overlap: %v %+v", ok, got)
	}
}

func TestMixedReflowMarkPreservesBothSides(t *testing.T) {
	source := reflowTestMark("source", "one two three", 0, 7, false)
	target := reflowTestMark("target", "one two three", 0, 7, true)
	var sourceLoc, targetLoc map[string]json.RawMessage
	json.Unmarshal(source.Location, &sourceLoc)
	json.Unmarshal(target.Location, &targetLoc)
	sourceLoc["translation"] = targetLoc["translation"]
	source.Location, _ = json.Marshal(sourceLoc)
	source = enrichTranslationAnnotation(source, nil)
	if !bytes.Contains(source.Location, []byte(`"sourceAnchors"`)) || !bytes.Contains(source.Location, []byte(`"translation"`)) {
		t.Fatal("saving translation metadata discarded a side")
	}
	duplicate := source
	duplicate.ID = "duplicate"
	duplicate.Note = "note"
	merged, ok := mergeAnnotationMark(source, duplicate)
	if !ok || merged.Note != "note" || !bytes.Contains(merged.Location, []byte(`"sourceAnchors"`)) || !bytes.Contains(merged.Location, []byte(`"translation"`)) {
		t.Fatalf("duplicate: %v %+v", ok, merged)
	}
	if _, ok := mergeAnnotationMark(source, target); ok {
		t.Fatal("mixed mark merged as translation-only, losing source")
	}
	other := reflowTestMark("other", "one two three", 4, 13, true)
	var otherLoc map[string]json.RawMessage
	json.Unmarshal(other.Location, &otherLoc)
	sourceLoc["translation"] = otherLoc["translation"]
	other.Location, _ = json.Marshal(sourceLoc)
	if _, ok := mergeAnnotationMark(source, other); ok {
		t.Fatal("partial mixed ranges merged without reconciling both sides")
	}
}
