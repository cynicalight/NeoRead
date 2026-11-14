package neoread

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func reparseSettings(t *testing.T, s *Server, settings string) {
	t.Helper()
	if _, err := s.Store.DB.Exec("INSERT INTO settings(key,value) VALUES('neoread',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", settings); err != nil {
		t.Fatal(err)
	}
}

func TestReparseAutomaticPaperPolicy(t *testing.T) {
	for _, tc := range []struct {
		name     string
		settings string
		pages    int
		manual   bool
	}{
		{"zero", `{"autoTranslateMaxPages":0}`, 1, true},
		{"above", `{"autoTranslateMaxPages":10}`, 11, true},
		{"equal", `{"autoTranslateMaxPages":10}`, 10, false},
		{"below", `{"autoTranslateMaxPages":10}`, 9, false},
		{"legacy-off", `{"autoTranslatePDF":false}`, 1, true},
		{"default-above", `{}`, 51, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, m := completedTranslationFixture(t)
			prepareReparseDocument(t, s)
			if tc.name == "below" {
				m.Pages = 100
				if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			m.Pages = tc.pages
			calls := reparseFixture(t, m)
			reparseSettings(t, s, tc.settings)
			var paragraphs atomic.Int32
			defer reparseTranslationProvider(t, s, &paragraphs)()
			p := queueReparseForTest(t, s, "doc")
			reparseSettings(t, s, `{"autoTranslateMaxPages":150}`)
			if !tc.manual {
				reparseSettings(t, s, `{"autoTranslateMaxPages":0}`)
			}
			p = assistanceRequest(t, s, "pause")
			p = assistanceRequest(t, s, "resume")
			if err := s.processTranslation(t.Context(), &p); err != nil {
				t.Fatal(err)
			}
			if p.PagesTotal != tc.pages || p.ManualTranslation != tc.manual || p.LayoutRevision == "" {
				t.Fatal("new layout or captured policy lost", p)
			}
			if !tc.manual {
				if paragraphs.Load() != 2 || p.Status != "complete" {
					t.Fatal("authorized paper was not translated", paragraphs.Load(), p)
				}
				return
			}
			if paragraphs.Load() != 0 || p.Status != "paused" || p.Enabled || p.Retranslating {
				t.Fatal("automatic gate was bypassed", paragraphs.Load(), p)
			}
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			s.StartProcessing(ctx)()
			p, _ = s.Store.processing("doc")
			if err := s.processTranslation(t.Context(), &p); err != nil || p.Status != "paused" || paragraphs.Load() != 0 {
				t.Fatal("restart bypassed manual policy", p, err)
			}
			p = assistanceRequest(t, s, "start")
			if err := s.learnPDF(t.Context(), &p); err != nil {
				t.Fatal(err)
			}
			if err := s.processTranslation(t.Context(), &p); err != nil || p.Status != "complete" || paragraphs.Load() != 2 {
				t.Fatal("manual start did not use prepared source", p, err)
			}
			if data, err := os.ReadFile(calls); err != nil || string(data) != "parse\n" {
				t.Fatal("manual start reparsed the source", string(data), err)
			}
		})
	}
}

func TestReparseDeniedPolicyMakesNoTextOrFormulaCalls(t *testing.T) {
	for _, tc := range []struct {
		library  string
		settings string
		pages    int
	}{
		{"papers", `{"autoTranslateMaxPages":0}`, 1},
		{"papers", `{"autoTranslateMaxPages":10}`, 11},
		{"papers", `{"autoTranslatePDF":false}`, 1},
		{"books", `{"autoTranslateMaxPages":150}`, 1},
	} {
		t.Run(tc.library+"/"+tc.settings, func(t *testing.T) {
			s, _, m := completedTranslationFixture(t)
			prepareReparseDocument(t, s)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library=? WHERE id='doc'", tc.library); err != nil {
				t.Fatal(err)
			}
			formula := m.Blocks[0]
			formula.ID, formula.Label, formula.Image, formula.Text = "p1-b3", "display_formula", "assets/p1-b3.png", "x"
			m.Blocks = append(m.Blocks, formula)
			m.Pages = tc.pages
			reparseFixture(t, m)
			reparseSettings(t, s, tc.settings)
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				http.Error(w, "unexpected provider call", 500)
			}))
			defer provider.Close()
			configureFormulaTest(t, s, provider.URL, provider.URL)
			p := queueReparseForTest(t, s, "doc")
			if err := s.processTranslation(t.Context(), &p); err != nil || calls.Load() != 0 || p.Status != "paused" {
				t.Fatal("policy gate ran after a provider", p, calls.Load(), err)
			}
		})
	}
}

func TestReparseBookChapterDoesNotExpandToWholeBook(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	m.Pages = 2
	m.Blocks[1].ID, m.Blocks[1].Page = "p2-b1", 2
	reparseFixture(t, m)
	var paragraphs atomic.Int32
	defer reparseTranslationProvider(t, s, &paragraphs)()
	p := queueReparseForTest(t, s, "doc")
	if err := s.processTranslation(t.Context(), &p); err != nil || paragraphs.Load() != 0 {
		t.Fatal(p, err)
	}
	response := request(t, s, "POST", "/api/documents/doc/translations/range", strings.NewReader(`{"fromPage":1,"toPage":1}`))
	if response.Code != 202 {
		t.Fatal(response.Code, response.Body.String())
	}
	p, _ = s.Store.processing("doc")
	if p.Retranslating {
		t.Fatal("chapter inherited full restart mode", p)
	}
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	current, err := s.readLayout("doc")
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.translations("doc", current)
	if err != nil || paragraphs.Load() != 1 || items[0].Status != "complete" || items[1].Status != "idle" {
		t.Fatal("chapter requested unrelated units", items, paragraphs.Load(), err)
	}
}

func TestExplicitPaperRetranslationIgnoresAutomaticLimit(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	m.Pages = 100
	reparseFixture(t, m)
	reparseSettings(t, s, `{"autoTranslateMaxPages":0}`)
	var paragraphs atomic.Int32
	defer reparseTranslationProvider(t, s, &paragraphs)()
	p := assistanceRequest(t, s, "retranslate")
	if err := s.processTranslation(t.Context(), &p); err != nil || paragraphs.Load() != 2 || p.Status != "complete" {
		t.Fatal("explicit manual authorization was gated", p, paragraphs.Load(), err)
	}
}

func TestExplicitFullRetranslationRejectsBooks(t *testing.T) {
	for _, kind := range []string{"pdf", "epub"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _ := completedTranslationFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library='books',type=? WHERE id='doc'", kind); err != nil {
				t.Fatal(err)
			}
			response := request(t, s, "POST", "/api/documents/doc/assistance", strings.NewReader(`{"action":"retranslate"}`))
			if response.Code != 400 || !strings.Contains(response.Body.String(), "按章节翻译") {
				t.Fatal("book accepted full retranslation", response.Code, response.Body.String())
			}
		})
	}
}
