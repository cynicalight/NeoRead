package reader

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func epubRangeFixture(t *testing.T, toc []epubReaderLink) (*Server, epubTranslationDocument) {
	t.Helper()
	s, _ := processingFixture(t)
	s.Token = "test-secret"
	if _, err := s.Store.DB.Exec("UPDATE documents SET type='epub',library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(s.Store.Root, "cache", "doc")
	manifest := epubReaderManifest{ReadingOrder: []epubReaderLink{{Href: "a.xhtml", Type: "application/xhtml+xml"}, {Href: "b.xhtml", Type: "application/xhtml+xml"}}, TOC: toc}
	data, _ := json.Marshal(manifest)
	for name, text := range map[string]string{
		"manifest.json": string(data),
		"a.xhtml":       `<html><body><h1 id="one">Chapter one</h1><p>First paragraph.</p><a id="two"></a><h1>Chapter two</h1><p>Second paragraph.</p></body></html>`,
		"b.xhtml":       `<html><body><h1 id="three">Chapter three</h1><p>Third paragraph.</p></body></html>`,
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Store.saveProcessing(initialDocumentProcessing(Document{ID: "doc", Type: "epub"}, "")); err != nil {
		t.Fatal(err)
	}
	blocks, err := s.readEPUBBlocks("doc")
	if err != nil {
		t.Fatal(err)
	}
	return s, blocks
}

func TestEPUBChapterBoundaries(t *testing.T) {
	toc := []epubReaderLink{{Href: "a.xhtml#one"}, {Href: "a.xhtml#two"}, {Href: "b.xhtml#three"}}
	for _, test := range []struct {
		name     string
		toc      []epubReaderLink
		href     string
		block    int
		from, to int
	}{
		{"fragment", toc, "a.xhtml#two", -1, 2, 4},
		{"scrolled block", toc, "a.xhtml", 3, 2, 4},
		{"first", toc, "a.xhtml", 1, 0, 2},
		{"single parent", []epubReaderLink{{Href: "a.xhtml", Children: toc}}, "a.xhtml", 3, 2, 4},
		{"no toc", nil, "a.xhtml", 3, 0, 4},
		{"second spine", nil, "b.xhtml", 4, 4, 6},
		{"chapter spans files", []epubReaderLink{{Href: "a.xhtml#one"}}, "b.xhtml", 4, 0, 6},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, b := epubRangeFixture(t, test.toc)
			loc := EPUBReadingLocation{Type: "epub", Href: test.href}
			if test.block >= 0 {
				loc.BlockID = b[test.block].ID
			}
			from, to, err := s.epubTranslationChapter("doc", b, loc)
			if err != nil || from != test.from || to != test.to {
				t.Fatalf("%d:%d %v", from, to, err)
			}
		})
	}
}

func requestEPUBChapter(t *testing.T, s *Server, loc EPUBReadingLocation) (int, epubTranslationRange) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"location": loc})
	w := request(t, s, "POST", "/api/documents/doc/translations/chapter", strings.NewReader(string(data)))
	var result epubTranslationRange
	if w.Code == 202 {
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, result
}

func TestEPUBChapterRequestQueuesOnlyItsScopeAndReusesCompleted(t *testing.T) {
	s, blocks := epubRangeFixture(t, []epubReaderLink{{Href: "a.xhtml#one"}, {Href: "a.xhtml#two"}, {Href: "b.xhtml#three"}})
	items, _ := s.translations("doc", blocks)
	for _, item := range items {
		if item.Status != "idle" {
			t.Fatal("import authorized translation")
		}
	}
	completed := items[2]
	completed.Status = "complete"
	completed.Sentences = []TranslationSentence{{Source: blocks[2].Text, Target: "已完成"}}
	if err := s.saveTranslation("doc", completed); err != nil {
		t.Fatal(err)
	}
	code, res := requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "a.xhtml#two"})
	if code != 202 || res.Queued != 1 {
		t.Fatalf("%d %+v", code, res)
	}
	items, _ = s.translations("doc", blocks)
	for i, item := range items {
		want := "idle"
		if i == 2 {
			want = "complete"
		}
		if i == 3 {
			want = "pending"
		}
		if item.Status != want {
			t.Fatalf("%d %+v", i, item)
		}
	}
	if items[2].Sentences[0].Target != "已完成" {
		t.Fatal("completed translation lost")
	}
	if r := request(t, s, "POST", "/api/documents/doc/assistance", strings.NewReader(`{"action":"pause"}`)); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	if r := request(t, s, "POST", "/api/documents/doc/assistance", strings.NewReader(`{"action":"resume"}`)); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	p, _ := s.Store.processing("doc")
	if p.Phase != "translating" || !p.Enabled {
		t.Fatalf("EPUB entered PDF layout: %+v", p)
	}
	if r := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{}`)); r.Code != 400 {
		t.Fatal("whole EPUB request allowed")
	}
	code, _ = requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "a.xhtml", BlockID: blocks[4].ID})
	if code != 400 {
		t.Fatal("foreign chapter block accepted")
	}
	code, _ = requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "../escape.xhtml"})
	if code != 400 {
		t.Fatal("outside path accepted")
	}
}

func TestEPUBManualMigrationPausesOldWorkOnce(t *testing.T) {
	s, blocks := epubRangeFixture(t, nil)
	items, _ := s.translations("doc", blocks)
	for i := 0; i < 3; i++ {
		items[i].Status = []string{"complete", "running", "failed"}[i]
		items[i].Sentences = []TranslationSentence{{Source: blocks[i].Text, Target: "保留"}}
		if err := s.saveTranslation("doc", items[i]); err != nil {
			t.Fatal(err)
		}
	}
	p, _ := s.Store.processing("doc")
	p.EPUBManual = false
	p.Status = "queued"
	p.StartedAt = now()
	p.Translating = &ProcessingStage{Status: "queued"}
	_ = s.Store.saveProcessing(p)
	if err := s.Store.prepareManualEPUBProcessing(); err != nil {
		t.Fatal(err)
	}
	p, _ = s.Store.processing("doc")
	if p.Enabled || p.Status != "paused" || !p.EPUBManual {
		t.Fatalf("old job resumed: %+v", p)
	}
	items, _ = s.translations("doc", blocks)
	if items[0].Status != "complete" || items[0].Sentences[0].Target != "保留" || items[1].Status != "idle" || items[2].Status != "idle" {
		t.Fatal(items)
	}
	code, _ := requestEPUBChapter(t, s, blocks[0].Location)
	if code != 202 {
		t.Fatal(code)
	}
	if err := s.Store.prepareManualEPUBProcessing(); err != nil {
		t.Fatal(err)
	}
	p, _ = s.Store.processing("doc")
	if !p.Enabled || p.Status != "queued" {
		t.Fatal("migration repeated")
	}
	items, _ = s.translations("doc", blocks)
	if items[1].Status != "pending" || items[4].Status != "idle" {
		t.Fatal(items)
	}
}

func TestEPUBChapterLimitContinuesWithoutRetranslating(t *testing.T) {
	s, _ := epubRangeFixture(t, nil)
	source := `<html><body><p>` + strings.Repeat("字", 25000) + `</p><p>` + strings.Repeat("另", 25000) + `</p></body></html>`
	if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "a.xhtml"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	code, first := requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "a.xhtml"})
	if code != 202 || first.Queued != 1 || first.Characters != 25000 || !first.HasMore {
		t.Fatalf("%d %+v", code, first)
	}
	code, second := requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "a.xhtml"})
	if code != 202 || second.Queued != 1 || second.HasMore {
		t.Fatalf("%d %+v", code, second)
	}
}

func TestEPUBSourceIsStrictWhilePDFRepairsRemainAvailable(t *testing.T) {
	raw := sentencesJSON("The AGENT reads the paper. It writes a summary.")
	source := "The A GENT reads the paper. It writes a sum- mary."
	if _, err := parseTranslationSource(raw, source, false); err == nil {
		t.Fatal("EPUB source was rewritten")
	}
	if _, err := parseTranslationSource(raw, source, true); err != nil {
		t.Fatal(err)
	}
	prompt := translationPrompt(Document{Type: "epub"}, epubTranslationDocument{}, translationBatch{}, "")
	if strings.Contains(prompt, "原文由 PDF") || !strings.Contains(prompt, "禁止修正") {
		t.Fatal(prompt)
	}
}
