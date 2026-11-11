package neoread

import (
	"encoding/json"
	"testing"
)

func TestEPUBBlockMarkUnion(t *testing.T) {
	blocks, _ := epubTextBlocks("chapter.xhtml", "<html><body><p>one two three</p><p>four five six</p></body></html>")
	makeMark := func(id, kind string, start, end int) Annotation {
		loc, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "blockId": blocks[0].ID, "start": start, "end": end})
		return Annotation{ID: id, DocumentID: "doc", Kind: kind, Color: "#e6b94c", Location: loc, Quote: blocks[0].Text[start:end]}
	}
	for _, kind := range []string{"highlight", "underline"} {
		a, b := makeMark("a", kind, 0, 7), makeMark("b", kind, 4, 13)
		for _, pair := range [][2]Annotation{{a, a}, {a, b}, {b, a}} {
			merged, ok := mergeAnnotationMark(pair[0], pair[1], blocks)
			if !ok {
				t.Fatal("not merged", kind)
			}
			expected := "one two three"
			if pair[0].ID == pair[1].ID {
				expected = "one two"
			}
			if merged.Quote != expected {
				t.Fatal(merged.Quote)
			}
		}
		touching := makeMark("c", kind, 7, 13)
		if _, ok := mergeAnnotationMark(a, touching, blocks); ok {
			t.Fatal("touching merged")
		}
		b.Color = "#ff0000"
		if _, ok := mergeAnnotationMark(a, b, blocks); ok {
			t.Fatal("colors merged")
		}
	}
}

func TestEPUBBlockMarkSaveDeduplicates(t *testing.T) {
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
	block := blocks[0]
	loc, _ := json.Marshal(map[string]any{"type": "epub", "href": block.Location.Href, "blockId": block.ID, "start": 0, "end": utf16Length(block.Text)})
	a := Annotation{ID: "first", DocumentID: doc.ID, Kind: "highlight", Location: loc, Quote: block.Text, Color: "yellow", Note: "keep"}
	first, err := s.Store.saveAnnotation(a)
	if err != nil {
		t.Fatal(err)
	}
	a.ID = "second"
	second, err := s.Store.saveAnnotation(a)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || second.Note != "keep" {
		t.Fatal("not deduplicated")
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=?", doc.ID).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
}

func TestEPUBBlockMarkRepeatedTextAndCrossChapter(t *testing.T) {
	first, _ := epubTextBlocks("z.xhtml", "<html><body><p>ababa 😀</p><p>middle</p></body></html>")
	last, _ := epubTextBlocks("a.xhtml", "<html><body><p>ending</p></body></html>")
	blocks := append(first, last...)
	mark := func(from, to, start, end int) Annotation {
		loc, _ := json.Marshal(map[string]any{"type": "epub", "href": blocks[from].Location.Href, "blockId": blocks[from].ID, "start": start, "end": end, "endBlockId": blocks[to].ID, "endHref": blocks[to].Location.Href})
		return Annotation{Kind: "highlight", Color: "yellow", Location: loc, Quote: "aba"}
	}
	merged, ok := mergeAnnotationMark(mark(0, 0, 0, 3), mark(0, 0, 2, 5), blocks)
	if !ok || merged.Quote != "ababa" {
		t.Fatal(string(merged.Location), merged.Quote)
	}
	merged, ok = mergeAnnotationMark(mark(0, 1, 0, 4), mark(1, 2, 2, 3), blocks)
	if !ok || merged.Quote != "ababa 😀\n\nmiddle\n\nend" {
		t.Fatal(string(merged.Location), merged.Quote)
	}
	var loc map[string]any
	json.Unmarshal(merged.Location, &loc)
	if loc["href"] != "z.xhtml" || loc["endHref"] != "a.xhtml" || loc["endBlockId"] != last[0].ID {
		t.Fatal(loc)
	}
	invalid := mark(0, 0, 7, 8)
	if _, ok = mergeAnnotationMark(invalid, mark(0, 0, 6, 8), blocks); ok {
		t.Fatal("surrogate split merged")
	}
}

func TestEPUBBlockMarkUnionSkipsImageText(t *testing.T) {
	for _, alt := range []string{"Chart description", ""} {
		t.Run("alt="+alt, func(t *testing.T) {
			blocks, err := epubTextBlocks("chapter.xhtml", `<html><body><p>one two three</p><img src="chart.png" alt="`+alt+`"/><p>four five six</p></body></html>`)
			if err != nil || len(blocks) != 3 || blocks[1].Image == "" {
				t.Fatalf("image fixture: %+v, %v", blocks, err)
			}
			mark := func(kind string, first, start, end int, quote string) Annotation {
				loc, _ := json.Marshal(map[string]any{"type": "epub", "href": "chapter.xhtml", "blockId": blocks[first].ID, "endBlockId": blocks[2].ID, "start": start, "end": end})
				return Annotation{Kind: kind, Color: "yellow", Location: loc, Quote: quote}
			}
			for _, kind := range []string{"highlight", "underline"} {
				a := mark(kind, 0, 4, 4, "two three\n\nfour")
				b := mark(kind, 2, 2, 9, "ur five")
				for _, pair := range [][2]Annotation{{a, b}, {b, a}} {
					merged, ok := mergeAnnotationMark(pair[0], pair[1], blocks)
					if !ok || merged.Quote != "two three\n\nfour five" {
						t.Fatalf("%s merged quote: %q, merged=%v", kind, merged.Quote, ok)
					}
					var loc struct {
						BlockID, EndBlockID, Quote string
						Start, End                 int
					}
					if err := json.Unmarshal(merged.Location, &loc); err != nil || loc.BlockID != blocks[0].ID || loc.EndBlockID != blocks[2].ID || loc.Start != 4 || loc.End != 9 || loc.Quote != merged.Quote {
						t.Fatalf("merged location: %s, %v", merged.Location, err)
					}
				}
			}
		})
	}
}
