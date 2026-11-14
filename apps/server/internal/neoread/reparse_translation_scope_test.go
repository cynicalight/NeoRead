package neoread

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestReparsePersistsUnchangedTextAndFormulaAsPending(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	formula := m.Blocks[0]
	formula.ID, formula.Label, formula.Image, formula.Text = "p1-b3", "display_formula", "assets/p1-b3.png", "x"
	m.Blocks = append(m.Blocks, formula)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	old := newTranslation(formula)
	old.Status, old.FormulaMarkdown = "complete", "$$x$$"
	if err := s.saveTranslation("doc", old); err != nil {
		t.Fatal(err)
	}
	reparseFixture(t, m)
	queueReparseForTest(t, s, "doc")
	finishQueuedReparse(t, s, "doc")
	current, err := s.readLayout("doc")
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.translations("doc", current)
	if err != nil || len(items) != 3 || items[2].Status != "pending" || items[2].FormulaMarkdown != "" || len(items[0].Sentences) != 0 {
		t.Fatal("reparse reused old text or formula output", items, err)
	}
}

func TestReparsePublishesSourceThenWaitsForProviderConfiguration(t *testing.T) {
	for _, config := range []AIConfig{{}, {Primary: "claude", TranslationModels: map[string]string{"claude": "unverified-model"}}} {
		name := config.Primary
		if name == "" {
			name = "unconfigured"
		}
		t.Run(name, func(t *testing.T) {
			s, _, m := completedTranslationFixture(t)
			prepareReparseDocument(t, s)
			reparseFixture(t, m)
			if err := s.writeAIConfig(config); err != nil {
				t.Fatal(err)
			}
			p := queueReparseForTest(t, s, "doc")
			options, err := s.retranslationOptions(&p)
			if err != nil || options.Provider != "" || options.Model != "" {
				t.Fatal("unverified provider was frozen into the restart", options, err)
			}
			if err := s.processTranslation(t.Context(), &p); err != nil {
				t.Fatal(err)
			}
			if p.Status != "waiting" || p.LayoutRevision == "" || !p.Retranslating {
				t.Fatal("missing configuration was reported as completion", p)
			}
			var paragraphs atomic.Int32
			defer reparseTranslationProvider(t, s, &paragraphs)()
			p = assistanceRequest(t, s, "resume")
			if err := s.processTranslation(t.Context(), &p); err != nil {
				t.Fatal(err)
			}
			if p.Status != "complete" || paragraphs.Load() != 2 {
				t.Fatal("task queued without a verified provider could not switch and resume", p, paragraphs.Load())
			}
		})
	}
}
