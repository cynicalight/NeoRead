package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requestChapterStatus(t *testing.T, s *Server, body string) (int, translationChapterStatus) {
	t.Helper()
	w := request(t, s, "POST", "/api/documents/doc/translations/chapter-status", strings.NewReader(body))
	var out translationChapterStatus
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, out
}

func TestEPUBChapterStatusFollowsTheLocationChapter(t *testing.T) {
	s, blocks := epubRangeFixture(t, []epubReaderLink{{Href: "a.xhtml#one", Title: "One"}, {Href: "a.xhtml#two", Title: " Two "}, {Href: "b.xhtml#three", Title: "Three"}})
	items, _ := s.translations("doc", blocks)
	done := items[2]
	done.Status = "complete"
	failed := items[3]
	failed.Status, failed.Error = "failed", "timeout"
	for _, item := range []TranslationBlock{done, failed} {
		if err := s.saveTranslation("doc", item); err != nil {
			t.Fatal(err)
		}
	}
	body, _ := json.Marshal(map[string]any{"location": EPUBReadingLocation{Type: "epub", Href: "a.xhtml", BlockID: blocks[3].ID}})
	code, got := requestChapterStatus(t, s, string(body))
	if code != 200 || got.Key != blocks[2].ID || got.Title != "Two" || got.Total != 2 || got.Complete != 1 || got.Failed != 1 || got.Idle != 0 {
		t.Fatalf("%d %+v", code, got)
	}
	// Requesting a finished chapter queues nothing and the status stays done.
	if code, res := requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "a.xhtml#two"}); code != 202 || res.Queued != 1 {
		t.Fatalf("failed paragraph not retried: %d %+v", code, res)
	}
	_, got = requestChapterStatus(t, s, string(body))
	if got.Pending != 1 || got.Complete != 1 {
		t.Fatalf("%+v", got)
	}
	body, _ = json.Marshal(map[string]any{"location": EPUBReadingLocation{Type: "epub", Href: "b.xhtml"}})
	if _, got = requestChapterStatus(t, s, string(body)); got.Title != "Three" || got.Idle != 2 || got.Key != blocks[4].ID {
		t.Fatalf("%+v", got)
	}
}

func TestEPUBChapterStatusWithoutTOCUsesOpeningWords(t *testing.T) {
	s, _ := epubRangeFixture(t, nil)
	_, got := requestChapterStatus(t, s, `{"location":{"type":"epub","href":"b.xhtml"}}`)
	if got.Title != "Chapter three" || got.Total != 2 {
		t.Fatalf("%+v", got)
	}
	if code, _ := requestChapterStatus(t, s, `{"location":{"type":"epub","href":"../x.xhtml"}}`); code != 400 {
		t.Fatal("outside path accepted")
	}
}

func TestBookPDFChapterStatusReportsUnparsedAndParsingPages(t *testing.T) {
	s, _, m := bookFixture(t)
	m.ParsedPages = []int{1, 2, 3}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	code, got := requestChapterStatus(t, s, `{"fromPage":2,"toPage":5}`)
	if code != 200 || got.Key != "pages:2-5" || got.Unparsed != 2 || got.Parsing || got.Idle != 4 {
		t.Fatalf("%d %+v", code, got)
	}
	p, _ := s.Store.processing("doc")
	p.Chapter, p.Phase, p.Status, p.Enabled = &PageRange{4, 6}, "learning", "queued", true
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if _, got = requestChapterStatus(t, s, `{"fromPage":2,"toPage":5}`); !got.Parsing {
		t.Fatalf("%+v", got)
	}
	if _, got = requestChapterStatus(t, s, `{"fromPage":1,"toPage":2}`); got.Parsing || got.Unparsed != 0 {
		t.Fatalf("%+v", got)
	}
}
