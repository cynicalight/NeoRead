package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func completedFormulaCaption(t *testing.T, s *Server, m layoutManifest) {
	t.Helper()
	item := newTranslation(m.Blocks[1])
	item.Status = "complete"
	item.Sentences = []TranslationSentence{{Source: m.Blocks[1].Caption, Target: "已保存图注"}}
	if err := s.saveTranslation("doc", item); err != nil {
		t.Fatal(err)
	}
}

func TestFormulaCapabilityWaitResumesWithoutFailingSavedProse(t *testing.T) {
	s, p, m := formulaFixture(t)
	completedFormulaCaption(t, s, m)
	if err := s.writeAIConfig(AIConfig{Primary: "codex", Capabilities: map[string]Capability{}}); err != nil {
		t.Fatal(err)
	}
	p.Enabled = true
	p.Translating = &ProcessingStage{Status: "queued"}
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Status != "waiting" || p.Translating.Status != "waiting" || !strings.Contains(p.Detail, "图像能力") {
		t.Fatalf("formula wait: %+v", p)
	}
	items, err := s.translations("doc", m)
	if err != nil || items[0].Status != "pending" || items[0].Error != "" || items[1].Status != "complete" {
		t.Fatalf("lost waiting formula or saved caption: %+v %v", items, err)
	}
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		sendTranslationDelta(w, "$$x=1$$")
		finishTranslationStream(w)
	}))
	defer images.Close()
	configureFormulaTest(t, s, images.URL, images.URL)
	s.wakeProcessing()
	p, err = s.Store.processing("doc")
	if err != nil || p.Status != "queued" {
		t.Fatal(p, err)
	}
	if err = s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	items, err = s.translations("doc", m)
	if err != nil || p.Status != "complete" || items[0].FormulaMarkdown != "$$x=1$$\n" || items[1].Sentences[0].Target != "已保存图注" {
		t.Fatalf("failed to resume formula only: %+v %+v %v", p, items, err)
	}
}

func TestReopenedReparseRecoversOnlyLegacyFormulaCapabilityFailures(t *testing.T) {
	for _, mode := range []string{"waiting", "ready", "paused", "manual", "upstream"} {
		t.Run(mode, func(t *testing.T) {
			s, p, m := formulaFixture(t)
			completedFormulaCaption(t, s, m)
			m.RetranslationRun = strings.Repeat("a", 32)
			raw, _ := json.Marshal(m)
			if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			item := newTranslation(m.Blocks[0])
			item.Status = "failed"
			item.Error = "主 Agent 尚未通过所需能力测试"
			if mode == "upstream" {
				item.Error = "provider failed"
			}
			if err := s.saveTranslation("doc", item); err != nil {
				t.Fatal(err)
			}
			p.Enabled = mode != "paused"
			p.ManualTranslation = mode == "manual"
			p.LayoutRevision = m.RetranslationRun
			p.Translating = &ProcessingStage{Status: "failed", Detail: item.Error}
			aggregateProcessing(&p)
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			if mode == "ready" {
				c := AIConfig{Primary: "codex", ImageAPI: APIConnection{URL: "http://127.0.0.1:1", Model: "test"}, Capabilities: map[string]Capability{}}
				c.Capabilities["image-api"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(c, "image-api")}
				if err := s.writeAIConfig(c); err != nil {
					t.Fatal(err)
				}
			}
			d, err := s.Store.Document("doc")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.reparsedPDFLayout(d); err != nil {
				t.Fatal(err)
			}
			saved, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			items, err := s.translations("doc", m)
			if err != nil {
				t.Fatal(err)
			}
			want := "failed"
			if mode == "waiting" {
				want = "waiting"
			}
			if mode == "ready" {
				want = "queued"
			}
			if saved.Translating.Status != want {
				t.Fatalf("stage %s want %s", saved.Translating.Status, want)
			}
			status := "failed"
			if mode == "waiting" || mode == "ready" {
				status = "pending"
			}
			if items[0].Status != status || items[1].Status != "complete" {
				t.Fatalf("changed unrelated data: %+v", items)
			}
		})
	}
}
