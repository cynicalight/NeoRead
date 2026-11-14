package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func reparseTranslationProvider(t *testing.T, s *Server, paragraphs *atomic.Int32) func() {
	t.Helper()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		var response strings.Builder
		for _, paragraph := range batch.Paragraphs {
			paragraphs.Add(1)
			response.WriteString(translationParagraphLine(paragraph))
		}
		writeAPIReply(w, response.String())
	}))
	configureTranslationTest(t, s, provider.URL)
	return provider.Close
}

func queueReparseForTest(t *testing.T, s *Server, documentID string) Processing {
	t.Helper()
	response := request(t, s, "POST", "/api/documents/"+documentID+"/reparse", nil)
	var p Processing
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &p) != nil || p.DocumentID != documentID || p.Status != "queued" || !p.Retranslating {
		t.Fatal("reparse did not accept a persistent translation task", response.Code, response.Body.String())
	}
	return p
}

func waitForReparseTranslation(t *testing.T, s *Server, documentID string) Processing {
	t.Helper()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		p, err := s.Store.processing(documentID)
		if err != nil || p.Status == "failed" || p.Status == "waiting" {
			t.Fatal("reparse translation did not finish", p, err)
		}
		if (p.Status == "complete" || p.Status == "paused") && !p.Retranslating {
			return p
		}
		select {
		case <-deadline.C:
			t.Fatal("reparse translation remained unfinished", p)
		case <-tick.C:
		}
	}
}

func TestReparseWorkerHonorsPDFTranslationScope(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		for _, missing := range []bool{false, true} {
			t.Run(library+"/missing="+jsonText(missing), func(t *testing.T) {
				s, p, old := completedTranslationFixture(t)
				prepareReparseDocument(t, s)
				if _, err := s.Store.DB.Exec("UPDATE documents SET library=? WHERE id='doc'", library); err != nil {
					t.Fatal(err)
				}
				fresh := old
				fresh.Blocks = append([]PDFBlock(nil), old.Blocks...)
				fresh.Blocks[0].ID, fresh.Blocks[1].ID = "p1-b9", "p1-b10"
				reparseFixture(t, fresh)
				if missing {
					if err := os.RemoveAll(s.analysisDir("doc")); err != nil {
						t.Fatal(err)
					}
					if _, err := s.Store.DB.Exec("DELETE FROM translations WHERE document_id='doc'"); err != nil {
						t.Fatal(err)
					}
				}
				limit := 0
				p.AutoTranslateMaxPages, p.ManualTranslation, p.Chapter = &limit, true, &PageRange{1, 1}
				if err := s.Store.saveProcessing(p); err != nil {
					t.Fatal(err)
				}
				var paragraphs atomic.Int32
				defer reparseTranslationProvider(t, s, &paragraphs)()
				queued := queueReparseForTest(t, s, "doc")
				if queued.Chapter != nil || queued.ManualTranslation || (library == "papers" && queued.AutoTranslateMaxPages == nil) || paragraphs.Load() != 0 {
					t.Fatal("queue retained a chapter cap or called the provider synchronously", queued)
				}
				stop := s.StartProcessing(t.Context())
				defer stop()
				finished := waitForReparseTranslation(t, s, "doc")
				expected := int32(2)
				if library == "books" {
					expected = 0
				}
				if paragraphs.Load() != expected || finished.TranslationsDone != int(expected) || finished.LayoutRevision == "" {
					t.Fatal("worker ignored automatic translation scope", paragraphs.Load(), finished)
				}
			})
		}
	}
}

func TestReparseWorkerLeavesEPUBIdleWithoutPriorTranslations(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run("missing="+jsonText(missing), func(t *testing.T) {
			s := testServer(t)
			response := upload(t, s, "book.epub", sample(t, "the-art-of-reading.epub"))
			var d Document
			if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &d) != nil {
				t.Fatal(response.Code, response.Body.String())
			}
			blocks, err := s.readEPUBBlocks(d.ID)
			if err != nil {
				t.Fatal(err)
			}
			if missing {
				if err = os.RemoveAll(filepath.Join(s.Store.Root, "cache", d.ID)); err != nil {
					t.Fatal(err)
				}
			}
			var paragraphs atomic.Int32
			defer reparseTranslationProvider(t, s, &paragraphs)()
			p := queueReparseForTest(t, s, d.ID)
			p.EPUBManual = false
			if err = s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			stop := s.StartProcessing(t.Context())
			defer stop()
			finished := waitForReparseTranslation(t, s, d.ID)
			if paragraphs.Load() != 0 || finished.TranslationsDone != 0 || finished.LayoutRevision == "" || !finished.EPUBManual || finished.Status != "paused" {
				t.Fatal("EPUB reparse requested automatic translation", paragraphs.Load(), finished)
			}
			current, err := s.translations(d.ID, blocks)
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range current {
				if item.Status != "idle" {
					t.Fatal("EPUB reparse left runnable units", item)
				}
			}
		})
	}
}

func TestReparseEPUBResumesPublishedCacheBeforeReadyCheckpoint(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &d) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	p := queueReparseForTest(t, s, d.ID)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_epub_ready BEFORE UPDATE ON translation_restarts BEGIN SELECT RAISE(FAIL,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.refreshRetranslationLayout(t.Context(), &p); err == nil {
		t.Fatal("ready checkpoint failure was hidden")
	}
	if _, err := s.Store.DB.Exec("DROP TRIGGER reject_epub_ready"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Store.File(d), []byte("cannot parse this again"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.refreshRetranslationLayout(context.Background(), &p); err != nil {
		t.Fatal("published EPUB was parsed a second time", err)
	}
	if p.Retranslating || p.LayoutRevision == "" || p.Enabled {
		t.Fatal("published EPUB did not resume to chapter-only state", p)
	}
}
