package reader

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func completedTranslationFixture(t *testing.T) (*Server, Processing, layoutManifest) {
	t.Helper()
	s, p, m := translationFixture(t)
	for _, b := range m.Blocks {
		tx := newTranslation(b)
		tx.Status = "complete"
		tx.Sentences = []TranslationSentence{{Source: b.Text, Target: "旧译文"}}
		if err := s.saveTranslation("doc", tx); err != nil {
			t.Fatal(err)
		}
	}
	p.Translating = &ProcessingStage{Status: "complete"}
	p.TranslationsDone, p.TranslationsTotal = 2, 2
	aggregateProcessing(&p)
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	// A reachable fake provider is only needed by tests that actually generate.
	configureTranslationTest(t, s, "http://127.0.0.1:1")
	return s, p, m
}

func assertVisibleOldTranslation(t *testing.T, s *Server) {
	t.Helper()
	out := request(t, s, "GET", "/api/documents/doc/translations", nil)
	var items []TranslationBlock
	if out.Code != 200 || json.Unmarshal(out.Body.Bytes(), &items) != nil || len(items) < 2 {
		t.Fatal(out.Code, out.Body.String())
	}
	for _, item := range items[:2] {
		if item.Status != "complete" || len(item.Sentences) != 1 || item.Sentences[0].Target != "旧译文" {
			t.Fatalf("old translation lost: %+v", item)
		}
	}
}

func TestRetranslationPreservesTextFormulasAndSnapshotAcrossRestart(t *testing.T) {
	s, p, m := completedTranslationFixture(t)
	formula := m.Blocks[0]
	formula.ID, formula.Label, formula.Image, formula.Text = "p1-b3", "display_formula", "assets/p1-b3.png", "x"
	m.Blocks = append(m.Blocks, formula)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	f := newTranslation(formula)
	f.Status, f.FormulaMarkdown = "complete", "$$x$$"
	if err := s.saveTranslation("doc", f); err != nil {
		t.Fatal(err)
	}
	oldPrompt := "自然中文，保留术语"
	c := s.aiConfig()
	c.TranslationPrompt = &oldPrompt
	c.TranslationModels = map[string]string{"codex": "chosen-model"}
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	p = assistanceRequest(t, s, "retranslate")
	if !p.Retranslating || p.Phase != "translating" || p.Status != "queued" {
		t.Fatal(p)
	}
	assertVisibleOldTranslation(t, s)
	items, _ := s.translations("doc", m)
	if items[0].Status != "pending" || items[2].Status != "complete" || items[2].FormulaMarkdown != "$$x$$" {
		t.Fatal(items)
	}
	if out := request(t, s, "POST", "/api/documents/doc/assistance", strings.NewReader(`{"action":"retranslate"}`)); out.Code != 409 {
		t.Fatal("duplicate restart accepted", out.Code)
	}
	p = assistanceRequest(t, s, "pause")
	if p.Enabled || !p.Retranslating {
		t.Fatal(p)
	}
	store, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	reopened := NewServer(store, "test-secret", "")
	assertVisibleOldTranslation(t, reopened)
	options, err := reopened.retranslationOptions(&p)
	if err != nil || options.Prompt != oldPrompt || options.Model != "chosen-model" {
		t.Fatal(options, err)
	}
	changed := "其他提示词"
	c.TranslationPrompt = &changed
	c.TranslationModels["codex"] = "other-model"
	frozen := options.apply(c)
	if *frozen.TranslationPrompt != oldPrompt || frozen.TranslationModels["codex"] != "chosen-model" || c.TranslationModels["codex"] != "other-model" {
		t.Fatal("snapshot not isolated")
	}
	p = assistanceRequest(t, reopened, "resume")
	if p.Phase != "translating" || !p.Retranslating {
		t.Fatal("resume scheduled layout again", p)
	}
}

func TestRetranslationWaitsForProviderCompletionAndRetainsFailedOutput(t *testing.T) {
	for _, outcome := range []string{"success", "failure", "cancel"} {
		t.Run(outcome, func(t *testing.T) {
			s, _, m := completedTranslationFixture(t)
			assistanceRequest(t, s, "retranslate")
			doc, _ := s.Store.Document("doc")
			items, _ := s.translations("doc", m)
			batch := translationBatches(m, items, translationBatchCharacters)[0]
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			invoked := false
			stream := &GenerationService{primary: "codex", connections: map[string]generationConnection{
				"codex": {VerifiedText: true, Incremental: true, Adapter: retranslationTestAdapter(func(emit func(ProviderEvent) error) (GenerateResult, error) {
					invoked = true
					text := translationLine(m.Blocks[0]) + translationLine(m.Blocks[1])
					if err := emit(ProviderEvent{Text: text}); err != nil {
						return GenerateResult{}, err
					}
					assertVisibleOldTranslation(t, s)
					if outcome == "failure" {
						return GenerateResult{}, errors.New("connection lost")
					}
					if outcome == "cancel" {
						cancel()
						return GenerateResult{}, context.Canceled
					}
					return GenerateResult{Text: text, FinishReason: "stop"}, nil
				})},
			}}
			attempt, err := s.translationAttempt(ctx, doc, m, batch, stream, func() {})
			if !invoked {
				t.Fatal("provider path was not exercised")
			}
			if err != nil {
				t.Fatal(err)
			}
			if outcome != "success" {
				if attempt.err == nil || len(attempt.decoder.completed) != 0 {
					t.Fatal("failed replacement considered complete", attempt)
				}
				assertVisibleOldTranslation(t, s)
			} else {
				visible, _ := s.visibleTranslations("doc", m)
				if attempt.err != nil || visible[0].Sentences[0].Target != "译文。" {
					t.Fatal(attempt.err, visible)
				}
				previous, _ := s.translationPrevious("doc")
				if len(previous) != 0 {
					t.Fatal("successful replacement retained stale overlay")
				}
			}
		})
	}
}

type retranslationTestAdapter func(func(ProviderEvent) error) (GenerateResult, error)

func (f retranslationTestAdapter) Stream(_ context.Context, _ GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	return f(emit)
}

func TestRetranslationQueueRollsBackAndJoinsOldWorker(t *testing.T) {
	s, p, m := completedTranslationFixture(t)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_restart BEFORE INSERT ON translation_restarts BEGIN SELECT RAISE(FAIL,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.queueRetranslation(p, m, snapshotTranslationOptions(s.aiConfig())); err == nil {
		t.Fatal("transaction failure not returned")
	}
	items, _ := s.translations("doc", m)
	previous, _ := s.translationPrevious("doc")
	if items[0].Status != "complete" || len(previous) != 0 {
		t.Fatal("partially committed restart", items, previous)
	}
	if _, err := s.Store.DB.Exec("DROP TRIGGER reject_restart"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	task := &documentTask{cancel: cancel, done: make(chan struct{})}
	s.activeProcessing = map[string]*documentTask{"doc": task}
	go func() { <-ctx.Done(); s.finishProcessingTask("doc", task) }()
	assistanceRequest(t, s, "retranslate")
	select {
	case <-task.done:
	default:
		t.Fatal("old worker still active")
	}
	assertVisibleOldTranslation(t, s)
}

func TestRetranslationRunsThroughExistingLaneAndClearsRestartState(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		if len(batch.Paragraphs) != 2 {
			t.Error("missing retranslation scope")
		}
		writeAPIReply(w, translationLine(m.Blocks[0])+translationLine(m.Blocks[1]))
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	p := assistanceRequest(t, s, "retranslate")
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Status != "complete" || p.Retranslating || p.TranslationsDone != 2 {
		t.Fatal(p)
	}
	visible, _ := s.visibleTranslations("doc", m)
	if visible[0].Sentences[0].Target != "译文。" {
		t.Fatal(visible)
	}
}
