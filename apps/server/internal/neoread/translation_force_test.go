package neoread

import (
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

func visibleTranslationItems(t *testing.T, s *Server) []TranslationBlock {
	t.Helper()
	response := request(t, s, "GET", "/api/documents/doc/translations", nil)
	var items []TranslationBlock
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &items) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	return items
}

func forceTranslationBlock(t *testing.T, s *Server, blockID string) {
	t.Helper()
	body := jsonText(map[string]any{"blockId": blockID, "force": true})
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(body))
	if response.Code != 202 {
		t.Fatal(response.Code, response.Body.String())
	}
}

func TestForcedTranslationRunsOnlyRequestedUnitAcrossRestart(t *testing.T) {
	for _, kind := range []string{"paused-paper", "manual-paper", "mismatch-paper", "enabled-mismatch-paper", "enabled-pending-paper", "failed-paper", "paused-completed", "pdf-book", "epub"} {
		t.Run(kind, func(t *testing.T) {
			var s *Server
			var input translationInput
			if kind == "epub" {
				s, input = epubRangeFixture(t, nil)
			} else {
				var layout layoutManifest
				if kind == "mismatch-paper" || kind == "enabled-mismatch-paper" || kind == "paused-completed" {
					s, _, layout = completedTranslationFixture(t)
				} else {
					s, _, layout = translationFixture(t)
				}
				if kind == "mismatch-paper" || kind == "enabled-mismatch-paper" {
					layout.Blocks[1].ID = "p1-b9"
					if kind == "enabled-mismatch-paper" {
						layout.Blocks[0].ID = "p1-b8"
					}
					published := map[string]any{}
					if err := json.Unmarshal([]byte(jsonText(layout)), &published); err != nil {
						t.Fatal(err)
					}
					published["retranslationRun"] = id()
					if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(published)), 0600); err != nil {
						t.Fatal(err)
					}
				}
				input = layout
				if kind == "pdf-book" {
					if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
						t.Fatal(err)
					}
				}
			}
			p, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			limit := 0
			enabled := kind == "enabled-mismatch-paper" || kind == "enabled-pending-paper" || kind == "failed-paper"
			p.Enabled, p.ManualTranslation, p.AutoTranslateMaxPages = enabled, kind == "manual-paper", &limit
			p.Phase, p.Status = "translating", "paused"
			p.Translating = &ProcessingStage{Status: "paused"}
			if kind == "enabled-mismatch-paper" || kind == "enabled-pending-paper" {
				p.Phase, p.Status, p.Translating.Status = "ready", "complete", "complete"
			} else if kind == "failed-paper" {
				p.Status, p.Translating.Status = "failed", "failed"
			}
			if err = s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			items := input.translationItems()
			selected := items[1].BlockID
			// Paused papers can already have every unit persisted as pending.
			if kind == "paused-paper" || kind == "enabled-pending-paper" || kind == "failed-paper" {
				for _, item := range items {
					if kind == "failed-paper" {
						item.Status, item.Error = "failed", "之前翻译失败"
					}
					if err = s.saveTranslation("doc", item); err != nil {
						t.Fatal(err)
					}
				}
			}
			before := visibleTranslationItems(t, s)
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				batch := readTranslationInput(t, r).Batch
				if len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != selected {
					t.Errorf("single-unit consent translated other paragraphs: %+v", batch.Paragraphs)
				}
				var text strings.Builder
				for _, paragraph := range batch.Paragraphs {
					text.WriteString(translationParagraphLine(paragraph))
				}
				writeAPIReply(w, text.String())
			}))
			defer provider.Close()
			configureTranslationTest(t, s, provider.URL)
			forceTranslationBlock(t, s, selected)
			if kind == "paused-paper" {
				p, err = s.Store.processing("doc")
				if err != nil {
					t.Fatal(err)
				}
				p.Status, p.Translating.Status = "running", "running"
				if err = s.Store.saveProcessing(p); err != nil {
					t.Fatal(err)
				}
				interrupted := items[1]
				interrupted.Status = "running"
				if err = s.saveTranslation("doc", interrupted); err != nil {
					t.Fatal(err)
				}
			}
			store, err := OpenStore(s.Store.Root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.DB.Close()
			reopened := NewServer(store, "test-secret", "")
			if _, err = store.DB.Exec("UPDATE documents SET classification_status='done'"); err != nil {
				t.Fatal(err)
			}
			stop := reopened.StartProcessing(t.Context())
			defer stop()
			expectedStatus := "paused"
			if kind == "failed-paper" {
				expectedStatus = "failed"
			}
			deadline := time.Now().Add(8 * time.Second)
			for {
				got := visibleTranslationItems(t, reopened)
				p, err = store.processing("doc")
				if err != nil {
					t.Fatal(err)
				}
				if got[1].Status == "complete" && p.Status == expectedStatus {
					if len(got) != len(before) || got[1].Sentences[0].Target != "译文。" {
						t.Fatal("requested translation missing", got)
					}
					for i := range before {
						if i != 1 && jsonText(got[i]) != jsonText(before[i]) {
							t.Fatal("unrequested unit changed", before[i], got[i])
						}
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("queued single-unit request did not finish after restart", p, got)
				}
				time.Sleep(20 * time.Millisecond)
			}
			stop()
			if calls.Load() != 1 || p.Enabled != enabled || p.AutoTranslateMaxPages == nil || *p.AutoTranslateMaxPages != 0 || p.ManualTranslation != (kind == "manual-paper") {
				t.Fatal("single-unit request changed automatic/full-paper policy", calls.Load(), p)
			}
			if (kind == "pdf-book" || kind == "epub") && (p.TranslationsDone != 1 || p.TranslationsTotal != 1) {
				t.Fatal("unrequested idle units inflated single-paragraph progress", p)
			}
		})
	}
}

func TestForcedCompletedReplacementPreservesAnnotationsAndOtherUnits(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	a := scopedAnnotationFixture(t, s, m)
	unrelated := `{"id":"unrelated","location":{"type":"pdf","page":99},"note":{"not-decoded":true}}`
	if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES('unrelated','doc',?)", unrelated); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		batch := readTranslationInput(t, r).Batch
		if len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != m.Blocks[0].ID {
			t.Errorf("replacement touched other paragraphs: %+v", batch)
		}
		assertVisibleOldTranslation(t, s)
		writeAPIReply(w, translationLine(m.Blocks[0]))
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	cached := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p1-b1","force":false}`))
	if cached.Code != 202 {
		t.Fatal(cached.Code, cached.Body.String())
	}
	cachedProcessing, _ := s.Store.processing("doc")
	if err := s.processTranslation(t.Context(), &cachedProcessing); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("force=false regenerated a completed result")
	}
	assertVisibleOldTranslation(t, s)
	forceTranslationBlock(t, s, m.Blocks[0].ID)
	assertVisibleOldTranslation(t, s)
	p, _ := s.Store.processing("doc")
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	got := visibleTranslationItems(t, s)
	if calls.Load() != 1 || got[0].Sentences[0].Target != "译文。" || got[1].Sentences[0].Target != "旧译文" {
		t.Fatal("completed replacement was cached or leaked scope", calls.Load(), got)
	}
	var updated Annotation
	if err := json.Unmarshal([]byte(storedAnnotationBody(t, s, a.ID)), &updated); err != nil {
		t.Fatal(err)
	}
	before, after := recoveredMark(t, a), recoveredMark(t, updated)
	if after.Ranges[0].TargetText != "译文。" || jsonText(before.Ranges[1]) != jsonText(after.Ranges[1]) || updated.Note != a.Note || storedAnnotationBody(t, s, "unrelated") != unrelated {
		t.Fatal("replacement changed unrelated annotations or failed to recover selected range", updated)
	}
}

func TestForcedTranslationRejectsMissingUnitsAndSourceReparse(t *testing.T) {
	s, p, m := completedTranslationFixture(t)
	for _, body := range []string{`{"force":true}`, `{"force":true,"blockId":" "}`, `{"force":true,"blockId":"missing"}`} {
		response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(body))
		if response.Code != 400 && response.Code != 404 {
			t.Fatal("invalid single-unit request accepted", response.Code, response.Body.String())
		}
	}
	reference := m.Blocks[0]
	reference.ID, reference.Label, reference.Text = "p1-b3", "reference", "Not translatable."
	m.Blocks = append(m.Blocks, reference)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true,"blockId":"p1-b3"}`))
	if response.Code != 404 {
		t.Fatal("untranslatable unit accepted", response.Code, response.Body.String())
	}
	p.Retranslating = true
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true,"blockId":"p1-b1"}`))
	if response.Code != 409 {
		t.Fatal("single-unit request overlapped source reparse", response.Code, response.Body.String())
	}
	assertVisibleOldTranslation(t, s)
}

func TestForcedTranslationQueueFailurePreservesCompletedResult(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_block_queue BEFORE UPDATE ON document_processing BEGIN SELECT RAISE(FAIL,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true,"blockId":"p1-b1"}`))
	if response.Code != 500 {
		t.Fatal(response.Code, response.Body.String())
	}
	assertVisibleOldTranslation(t, s)
	items, err := s.translations("doc", m)
	if err != nil || items[0].Status != "complete" {
		t.Fatal("queue failure committed pending replacement", items, err)
	}
}

func TestForcedReplacementFailureRetainsLastSuccessForRetry(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	var failProvider atomic.Bool
	failProvider.Store(true)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		if len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != m.Blocks[0].ID {
			t.Errorf("replacement retry translated unrelated text: %+v", batch)
		}
		if failProvider.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		assertVisibleOldTranslation(t, s)
		writeAPIReply(w, translationLine(m.Blocks[0]))
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	forceTranslationBlock(t, s, m.Blocks[0].ID)
	p, _ := s.Store.processing("doc")
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	got := visibleTranslationItems(t, s)
	if got[0].Status != "failed" || got[1].Sentences[0].Target != "旧译文" {
		t.Fatal("failed replacement changed other saved results", got)
	}
	failProvider.Store(false)
	forceTranslationBlock(t, s, m.Blocks[0].ID)
	assertVisibleOldTranslation(t, s)
	p, _ = s.Store.processing("doc")
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	got = visibleTranslationItems(t, s)
	if got[0].Status != "complete" || got[0].Sentences[0].Target != "译文。" || got[1].Sentences[0].Target != "旧译文" {
		t.Fatal("retry did not replace exactly the requested result", got)
	}
}
