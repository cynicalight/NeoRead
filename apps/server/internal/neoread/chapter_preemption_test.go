package neoread

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func awaitChapterSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("chapter lifecycle did not advance")
	}
}

func chapterPreemptionFixture(t *testing.T, epub bool) (*Server, translationInput, func() int, []string) {
	t.Helper()
	if epub {
		s, blocks := epubRangeFixture(t, []epubReaderLink{{Href: "a.xhtml#one"}, {Href: "a.xhtml#two"}, {Href: "b.xhtml#three"}})
		return s, blocks, func() int {
			code, _ := requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "a.xhtml#two"})
			return code
		}, []string{blocks[2].ID, blocks[3].ID}
	}
	s, _, m := translationFixture(t)
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	m.Pages = 3
	for page := 2; page <= 3; page++ {
		b := m.Blocks[0]
		b.Page = page
		b.ID = fmt.Sprintf("p%d-b1", page)
		m.Blocks = append(m.Blocks, b)
	}
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	return s, m, func() int {
		code, _ := requestRange(t, s, 1, 1)
		return code
	}, []string{m.Blocks[0].ID, m.Blocks[1].ID}
}

func TestChapterPreemptsAndJoinsParagraphBeforeGeneration(t *testing.T) {
	for _, epub := range []bool{false, true} {
		for _, sameChapter := range []bool{false, true} {
			name := "pdf"
			if epub {
				name = "epub"
			}
			if sameChapter {
				name += "-same-chapter"
			} else {
				name += "-different-chapter"
			}
			t.Run(name, func(t *testing.T) {
				s, source, chapter, want := chapterPreemptionFixture(t, epub)
				items, err := s.translations("doc", source)
				if err != nil {
					t.Fatal(err)
				}
				oldID := items[len(items)-1].BlockID
				if sameChapter {
					oldID = want[0]
				}
				for _, item := range items {
					if slices.Contains(want, item.BlockID) {
						continue
					}
					item.Status = "complete"
					item.Sentences = []TranslationSentence{{Source: "saved source", Target: "saved translation"}}
					if err := s.saveTranslation("doc", item); err != nil {
						t.Fatal(err)
					}
				}
				note := `{"id":"keep-note","documentId":"doc","kind":"note","note":"keep my note","location":{"type":"pdf","page":3}}`
				if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES('keep-note','doc',?)", note); err != nil {
					t.Fatal(err)
				}
				p, _ := s.Store.processing("doc")
				p.Enabled, p.Phase, p.Status = true, "translating", "complete"
				p.Translating = &ProcessingStage{Status: "complete"}
				if err := s.Store.saveProcessing(p); err != nil {
					t.Fatal(err)
				}
				forceTranslationBlock(t, s, oldID)
				p, _ = s.Store.processing("doc")
				if p.TranslationScopeKind != "paragraph" || !slices.Equal(p.TranslationBlocks, []string{oldID}) {
					t.Fatal("paragraph request lost its execution scope", p)
				}
				before := visibleTranslationItems(t, s)
				started, canceled := make(chan struct{}), make(chan struct{})
				returned, releaseJoin, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
				var release sync.Once
				defer release.Do(func() { close(releaseJoin) })
				var calls atomic.Int32
				var sent []string
				var sentMu sync.Mutex
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					input := readTranslationInput(t, r)
					if calls.Add(1) == 1 {
						if len(input.Batch.Paragraphs) != 1 || input.Batch.Paragraphs[0].BlockID != oldID {
							t.Error("old paragraph request sent unrelated units", input.Batch.Paragraphs)
						}
						w.Header().Set("Content-Type", "text/event-stream")
						w.WriteHeader(200)
						w.(http.Flusher).Flush()
						close(started)
						<-r.Context().Done()
						close(canceled)
						return
					}
					select {
					case <-joined:
					default:
						t.Error("chapter generation started before the old worker joined")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					for _, paragraph := range input.Batch.Paragraphs {
						sentMu.Lock()
						sent = append(sent, paragraph.BlockID)
						sentMu.Unlock()
						sendTranslationDelta(w, translationParagraphLine(paragraph))
					}
					finishTranslationStream(w)
				}))
				defer provider.Close()
				configureTranslationTest(t, s, provider.URL)
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				task := &documentTask{cancel: cancel, done: make(chan struct{})}
				s.activeProcessing = map[string]*documentTask{"doc": task}
				workerErr := make(chan error, 1)
				go func() {
					workerErr <- s.processTranslation(ctx, &p)
					close(returned)
					<-releaseJoin
					close(joined)
					s.finishProcessingTask("doc", task)
				}()
				awaitChapterSignal(t, started)
				response := make(chan int, 1)
				go func() { response <- chapter() }()
				awaitChapterSignal(t, canceled)
				awaitChapterSignal(t, returned)
				select {
				case code := <-response:
					t.Fatal("chapter request returned before old worker exit", code)
				default:
				}
				state, _ := s.Store.processing("doc")
				if state.TranslationScopeKind == "chapter" || len(state.TranslationBlocks) != 0 {
					t.Fatal("chapter scope was published before join", state)
				}
				release.Do(func() { close(releaseJoin) })
				select {
				case code := <-response:
					if code != 202 {
						t.Fatal(code)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("chapter did not queue after join")
				}
				<-workerErr
				state, _ = s.Store.processing("doc")
				if state.TranslationScopeKind != "chapter" || !slices.Equal(state.TranslationBlocks, want) {
					t.Fatal("chapter inherited the old paragraph scope", state)
				}
				if err := s.processTranslation(t.Context(), &state); err != nil {
					t.Fatal(err)
				}
				sentMu.Lock()
				defer sentMu.Unlock()
				if !slices.Equal(sent, want) || calls.Load() != 2 {
					t.Fatal("chapter generated outside its authorized scope", sent, want, calls.Load())
				}
				after := visibleTranslationItems(t, s)
				for i, item := range before {
					if !slices.Contains(want, item.BlockID) && jsonText(item) != jsonText(after[i]) {
						t.Fatal("preemption changed an out-of-chapter saved translation", item, after[i])
					}
				}
				if storedAnnotationBody(t, s, "keep-note") != note {
					t.Fatal("chapter preemption changed notes")
				}
				if len(state.TranslationBlocks) != 0 || state.TranslationScopeKind != "" {
					t.Fatal("completed scope was not drained", state)
				}
			})
		}
	}
}

func TestChapterReplacesQueuedWaitingAndRestartedParagraphScopes(t *testing.T) {
	for _, epub := range []bool{false, true} {
		for _, status := range []string{"queued", "waiting", "running"} {
			for _, kind := range []string{"", "paragraph"} {
				t.Run(jsonText([]any{epub, status, kind}), func(t *testing.T) {
					s, source, chapter, want := chapterPreemptionFixture(t, epub)
					items, _ := s.translations("doc", source)
					old := items[len(items)-1]
					old.Status = "failed"
					if err := s.saveTranslation("doc", old); err != nil {
						t.Fatal(err)
					}
					p, _ := s.Store.processing("doc")
					p.Enabled, p.Phase, p.Status = true, "translating", status
					p.TranslationBlocks, p.TranslationScopeKind = []string{old.BlockID}, kind
					p.Translating = &ProcessingStage{Status: status}
					if err := s.Store.saveProcessing(p); err != nil {
						t.Fatal(err)
					}
					if status == "running" {
						ctx, cancel := context.WithCancel(t.Context())
						cancel()
						s.StartProcessing(ctx)()
					}
					if code := chapter(); code != 202 {
						t.Fatal(code)
					}
					s.wakeProcessing()
					p, _ = s.Store.processing("doc")
					if p.TranslationScopeKind != "chapter" || !slices.Equal(p.TranslationBlocks, want) {
						t.Fatal("queued or restored paragraph contaminated chapter scope", p)
					}
					items, _ = s.translations("doc", source)
					if items[len(items)-1].Status != "idle" {
						t.Fatal("canceled paragraph retained unfinished state", items)
					}
				})
			}
		}
	}
}

func TestChapterRejectsInvalidOrReparsingRequestsWithoutPreemption(t *testing.T) {
	for _, epub := range []bool{false, true} {
		t.Run(jsonText(epub), func(t *testing.T) {
			s, source, chapter, _ := chapterPreemptionFixture(t, epub)
			items, _ := s.translations("doc", source)
			p, _ := s.Store.processing("doc")
			p.TranslationBlocks, p.TranslationScopeKind = []string{items[len(items)-1].BlockID}, "paragraph"
			p.Translating = &ProcessingStage{Status: "running"}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			s.activeProcessing = map[string]*documentTask{"doc": {cancel: cancel, done: make(chan struct{})}}
			for _, reparsing := range []bool{false, true} {
				p.Retranslating = reparsing
				if err := s.Store.saveProcessing(p); err != nil {
					t.Fatal(err)
				}
				before, _ := s.Store.processing("doc")
				code := 0
				if reparsing {
					code = chapter()
				} else if epub {
					code, _ = requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "missing.xhtml"})
				} else {
					code, _ = requestRange(t, s, 4, 5)
				}
				if code != map[bool]int{false: 400, true: 409}[reparsing] || ctx.Err() != nil {
					t.Fatal("rejected chapter canceled existing paragraph", code, ctx.Err())
				}
				after, _ := s.Store.processing("doc")
				if jsonText(before) != jsonText(after) {
					t.Fatal("rejected chapter mutated processing state", before, after)
				}
			}
		})
	}
}

func TestChapterRequestsExtendEqualPriorityScopes(t *testing.T) {
	s, _, chapter, want := chapterPreemptionFixture(t, true)
	if chapter() != 202 {
		t.Fatal("first chapter rejected")
	}
	p, _ := s.Store.processing("doc")
	p.Translating = &ProcessingStage{Status: "running"}
	p.Status = "running"
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	s.activeProcessing = map[string]*documentTask{"doc": {cancel: cancel, done: make(chan struct{})}}
	blocks, _ := s.readEPUBBlocks("doc")
	code, _ := requestEPUBChapter(t, s, EPUBReadingLocation{Type: "epub", Href: "b.xhtml"})
	if code != 202 || ctx.Err() != nil {
		t.Fatal("equal-priority chapter preempted the running chapter", code)
	}
	p, _ = s.Store.processing("doc")
	want = append(want, blocks[4].ID, blocks[5].ID)
	if p.TranslationScopeKind != "chapter" || !slices.Equal(p.TranslationBlocks, want) || p.Translating.Status != "running" {
		t.Fatal("chapter queue merge lost the scope or active stage", p)
	}
	var sent []string
	var sentMu sync.Mutex
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input := readTranslationInput(t, r)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, paragraph := range input.Batch.Paragraphs {
			sentMu.Lock()
			sent = append(sent, paragraph.BlockID)
			sentMu.Unlock()
			sendTranslationDelta(w, translationParagraphLine(paragraph))
		}
		finishTranslationStream(w)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	first := p
	first.TranslationBlocks = slices.Clone(want[:2])
	if err := s.processTranslation(t.Context(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Status != "queued" || !slices.Equal(first.TranslationBlocks, want[2:]) {
		t.Fatal("old chapter completion discarded the extended scope", first)
	}
	if err := s.processTranslation(t.Context(), &first); err != nil {
		t.Fatal(err)
	}
	sentMu.Lock()
	defer sentMu.Unlock()
	if !slices.Equal(sent, want) || len(first.TranslationBlocks) != 0 || first.TranslationScopeKind != "" {
		t.Fatal("chapter extension was not drained exactly once", sent, first)
	}
}

func TestPartialPDFChapterPreemptsParagraphBeforeLayout(t *testing.T) {
	s, source, _, _ := chapterPreemptionFixture(t, false)
	m := source.(layoutManifest)
	m.ParsedPages, m.Blocks = []int{1}, m.Blocks[:2]
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	log := fakeLayout(t)
	p, _ := s.Store.processing("doc")
	p.TranslationBlocks, p.TranslationScopeKind = []string{m.Blocks[0].ID}, "paragraph"
	p.Translating = &ProcessingStage{Status: "waiting"}
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	code, result := requestRange(t, s, 2, 3)
	if code != 202 || !result.Parsing {
		t.Fatal("partial chapter skipped layout lane", code, result)
	}
	p, _ = s.Store.processing("doc")
	if p.Chapter == nil || p.Phase != "learning" || len(p.TranslationBlocks) != 0 || p.TranslationScopeKind != "chapter" {
		t.Fatal("layout inherited old paragraph execution IDs", p)
	}
	if err := s.learnPDF(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.TranslationBlocks, []string{"p2-b1", "p3-b1"}) || p.Chapter != nil || p.TranslationScopeKind != "chapter" {
		t.Fatal("layout handoff lost the authorized chapter scope", p)
	}
	calls, err := os.ReadFile(log)
	if err != nil || string(calls) != "2-3\n" {
		t.Fatal("parsed outside the requested chapter", string(calls), err)
	}
	var sent []string
	var sentMu sync.Mutex
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input := readTranslationInput(t, r)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, paragraph := range input.Batch.Paragraphs {
			sentMu.Lock()
			sent = append(sent, paragraph.BlockID)
			sentMu.Unlock()
			sendTranslationDelta(w, translationParagraphLine(paragraph))
		}
		finishTranslationStream(w)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	sentMu.Lock()
	defer sentMu.Unlock()
	if strings.Join(sent, ",") != "p2-b1,p3-b1" {
		t.Fatal("partial layout chapter translated old paragraph", sent)
	}
}

func TestParagraphCannotExpandOrDowngradeChapterScope(t *testing.T) {
	for _, epub := range []bool{false, true} {
		for _, status := range []string{"queued", "running", "waiting"} {
			t.Run(jsonText([]any{epub, status}), func(t *testing.T) {
				s, source, chapter, want := chapterPreemptionFixture(t, epub)
				if chapter() != 202 {
					t.Fatal("chapter rejected")
				}
				p, _ := s.Store.processing("doc")
				p.Translating = &ProcessingStage{Status: status}
				p.Status = status
				if err := s.Store.saveProcessing(p); err != nil {
					t.Fatal(err)
				}
				p, _ = s.Store.processing("doc")
				items, _ := s.translations("doc", source)
				beforeItems := jsonText(items)
				before := jsonText(p)
				for _, blockID := range []string{want[0], items[len(items)-1].BlockID} {
					response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(jsonText(map[string]any{"blockId": blockID, "force": true})))
					if response.Code != 409 || !strings.Contains(response.Body.String(), "暂停或完成当前章节") {
						t.Fatal("paragraph bypassed chapter priority", response.Code, response.Body.String())
					}
				}
				p, _ = s.Store.processing("doc")
				items, _ = s.translations("doc", source)
				if jsonText(p) != before || jsonText(items) != beforeItems {
					t.Fatal("rejected paragraph changed chapter scope or saved rows", p, items)
				}
			})
		}
	}
}

func TestPausingScopedTranslationClearsScopeKind(t *testing.T) {
	for _, kind := range []string{"paragraph", "chapter"} {
		t.Run(kind, func(t *testing.T) {
			s, _, chapter, _ := chapterPreemptionFixture(t, false)
			if chapter() != 202 {
				t.Fatal("chapter rejected")
			}
			p, _ := s.Store.processing("doc")
			p.TranslationScopeKind = kind
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			p = assistanceRequest(t, s, "pause")
			if p.Enabled || len(p.TranslationBlocks) != 0 || p.TranslationScopeKind != "" {
				t.Fatal("pause left an executable scope", p)
			}
		})
	}
}

func TestChapterRetractsCanceledParagraphRowsAndPublishesVisibleState(t *testing.T) {
	for _, epub := range []bool{false, true} {
		for _, status := range []string{"pending", "running", "failed", "complete"} {
			for _, previous := range []bool{false, true} {
				t.Run(jsonText([]any{epub, status, previous}), func(t *testing.T) {
					s, source, chapter, _ := chapterPreemptionFixture(t, epub)
					items, _ := s.translations("doc", source)
					old, unrelated := items[len(items)-1], items[len(items)-2]
					success := old
					success.Status = "complete"
					success.Sentences = []TranslationSentence{{Source: "saved source", Target: "saved target"}}
					if previous {
						if _, err := s.Store.DB.Exec("INSERT INTO translation_previous VALUES(?,?,?,?)", "doc", old.BlockID, old.SourceHash, jsonText(success)); err != nil {
							t.Fatal(err)
						}
					}
					old.Status, old.Error = status, "unfinished error"
					old.Sentences = []TranslationSentence{{Source: "partial source", Target: "partial target"}}
					old.FormulaMarkdown = "unfinished formula"
					if err := s.saveTranslation("doc", old); err != nil {
						t.Fatal(err)
					}
					unrelated.Status, unrelated.Error = "failed", "unrelated saved error"
					if err := s.saveTranslation("doc", unrelated); err != nil {
						t.Fatal(err)
					}
					p, _ := s.Store.processing("doc")
					p.Phase, p.Status = "translating", "waiting"
					p.Translating = &ProcessingStage{Status: "waiting"}
					p.TranslationBlocks, p.TranslationScopeKind = []string{old.BlockID}, "paragraph"
					if err := s.Store.saveProcessing(p); err != nil {
						t.Fatal(err)
					}
					events := make(chan TranslationBlock, 16)
					s.translationMu.Lock()
					s.translationSubscribers = map[string]map[chan TranslationBlock]struct{}{"doc": {events: {}}}
					s.translationMu.Unlock()
					if chapter() != 202 {
						t.Fatal("chapter rejected")
					}
					items, _ = s.translations("doc", source)
					got := items[len(items)-1]
					want := old
					if status != "complete" {
						if previous {
							want = success
						} else {
							want.Status, want.Error, want.FormulaMarkdown = "idle", "", ""
							want.Sentences = []TranslationSentence{}
						}
						select {
						case event := <-events:
							if jsonText(event) != jsonText(want) {
								t.Fatal("SSE did not revoke old paragraph before chapter queue events", event, want)
							}
						default:
							t.Fatal("retraction did not publish its visible state")
						}
					}
					if jsonText(got) != jsonText(want) || jsonText(items[len(items)-2]) != jsonText(unrelated) {
						t.Fatal("paragraph retraction changed successful or unrelated saved state", got, want, items)
					}
				})
			}
		}
	}
}
