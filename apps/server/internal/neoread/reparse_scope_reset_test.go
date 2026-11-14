package neoread

import (
	"sync/atomic"
	"testing"
)

func TestWholeReparseReplacesWaitingParagraphScope(t *testing.T) {
	for _, tc := range []struct {
		name       string
		settings   string
		pages      int
		automatic  bool
		paragraphs int32
	}{
		{"manual-full", `{"autoTranslateMaxPages":0}`, 2, false, 2},
		{"automatic-allowed", `{"autoTranslateMaxPages":10}`, 2, true, 2},
		{"automatic-disabled", `{"autoTranslateMaxPages":0}`, 2, true, 0},
		{"automatic-over-limit", `{"autoTranslateMaxPages":10}`, 11, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, p, m := completedTranslationFixture(t)
			prepareReparseDocument(t, s)
			m.Pages = tc.pages
			reparseFixture(t, m)
			reparseSettings(t, s, tc.settings)
			var paragraphs atomic.Int32
			defer reparseTranslationProvider(t, s, &paragraphs)()
			p.Enabled = false
			p.TranslationBlocks = []string{m.Blocks[0].ID}
			p.TranslationScopeKind = "paragraph"
			p.Phase, p.Status = "translating", "waiting"
			p.Translating = &ProcessingStage{Status: "waiting", Detail: "等待模型配置"}
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			if tc.automatic {
				p = queueReparseForTest(t, s, "doc")
			} else {
				p = assistanceRequest(t, s, "retranslate")
			}
			if len(p.TranslationBlocks) != 0 || p.TranslationScopeKind != "" {
				t.Fatal("whole reparse retained paragraph execution scope", p)
			}
			if err := s.processTranslation(t.Context(), &p); err != nil {
				t.Fatal(err)
			}
			if paragraphs.Load() != tc.paragraphs {
				t.Fatal("whole-document request inherited paragraph consent", paragraphs.Load(), p)
			}
			if tc.paragraphs == 0 {
				if p.Enabled || p.Status != "paused" || !p.ManualTranslation {
					t.Fatal("automatic page gate did not remain manual", p)
				}
			} else {
				items := visibleTranslationItems(t, s)
				for _, item := range items {
					if item.Status != "complete" || len(item.Sentences) != 1 || item.Sentences[0].Target != "译文。" {
						t.Fatal("previously completed paragraph was skipped by whole retranslation", item)
					}
				}
				if p.Status != "complete" {
					t.Fatal("whole retranslation did not complete", p)
				}
			}
		})
	}
}
