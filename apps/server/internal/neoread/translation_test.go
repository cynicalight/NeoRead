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

func translationFixture(t *testing.T) (*Server, Processing, layoutManifest) {
	t.Helper()
	s, p := processingFixture(t)
	s.Token = "test-secret"
	m, _ := s.readLayout("doc")
	b := m.Blocks[0]
	b.Image = ""
	b.Label = "text"
	b.Text = "First sentence. Second sentence."
	b2 := b
	b2.ID = "p1-b2"
	b2.Text = "Another paragraph."
	m.Blocks = []PDFBlock{b, b2}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.learnPDF(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	return s, p, m
}
func TestTranslationRejectsMissingUnrelatedOrEmptySentences(t *testing.T) {
	cases := []string{
		`{"sentences":[{"source":"First sentence.","target":"第一句。"}]}`,
		`{"sentences":[{"source":"Unrelated words here.","target":"无关。"}]}`,
		`{"sentences":[{"source":"First sentence. Second sentence.","target":""}]}`,
		`{"sentences":[`,
	}
	for _, raw := range cases {
		if _, err := parseTranslation(raw, "First sentence. Second sentence."); err == nil {
			t.Fatalf("accepted invalid alignment: %s", raw)
		}
	}
	sentences, err := parseTranslation(`{"sentences":[{"source":"First sentence.","target":"第一句。"},{"source":"Second sentence.","target":"第二句。"}]}`, "First sentence. Second sentence.")
	if err != nil || len(sentences) != 2 {
		t.Fatalf("valid sentences rejected: %v", err)
	}
}
func TestTranslationPartialFailureAndRetryPreservesCompletedBlocks(t *testing.T) {
	s, p, m := translationFixture(t)
	if p.Phase != "translating" {
		t.Fatal("text-only paper skipped translation")
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		mismatched := strings.Replace(translationLine(m.Blocks[1]), "Another paragraph.", "Unrelated words here.", 1)
		text := translationLine(m.Blocks[1])
		switch n {
		case 1:
			text = translationLine(m.Blocks[0]) + mismatched
		case 2: // The automatic follow-up asks for the rejected paragraph only.
			if batch := readTranslationInput(t, r).Batch; len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != m.Blocks[1].ID {
				t.Errorf("follow-up regenerated completed text: %+v", batch.Paragraphs)
			}
			text = mismatched
		}

		writeAPIReply(w, text)
	}))
	defer provider.Close()
	c := AIConfig{Primary: "codex", Models: map[string]string{}, TextAPI: APIConnection{URL: provider.URL, Model: "test"}, Capabilities: map[string]Capability{}}
	c.Capabilities["text-api"] = Capability{Text: true, Fingerprint: configPrint(c, "text-api")}
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatalf("individual paragraph failure interrupted processing: %v", err)
	}
	if p.Phase != "ready" || p.Status != "complete" || p.TranslationsDone != 1 || p.TranslationsTotal != 2 {
		t.Fatalf("partial failure lost translation progress: %+v", p)
	}
	response := request(t, s, "GET", "/api/documents/doc/translations", nil)
	var items []TranslationBlock
	if json.Unmarshal(response.Body.Bytes(), &items) != nil || len(items) != 2 || items[0].Status != "complete" || items[1].Status != "failed" {
		t.Fatalf("partial progress lost: %s", response.Body.String())
	}
	response = request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p1-b2"}`))
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	p, _ = s.Store.processing("doc")
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 || p.Status != "complete" {
		t.Fatalf("completed paragraph regenerated or job not complete: calls=%d %+v", calls.Load(), p)
	}
	// A changed source must never silently reuse the old translated text.
	m.Blocks[0].Text = "Changed source."
	items, err := s.translations("doc", m)
	if err != nil || items[0].Status != "pending" || len(items[0].Sentences) != 0 || items[1].Status != "complete" {
		t.Fatalf("stale source reused: %+v %v", items, err)
	}
}
func TestTranslationResumesInterruptedWithoutPrioritizingRequestedParagraph(t *testing.T) {
	s, p, m := translationFixture(t)
	first := newTranslation(m.Blocks[0])
	first.Status = "running"
	_ = s.saveTranslation("doc", first)
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p1-b2"}`))
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	var order []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		var out strings.Builder
		for _, paragraph := range batch.Paragraphs {
			order = append(order, paragraph.BlockID)
			out.WriteString(translationParagraphLine(paragraph))
		}
		writeAPIReply(w, out.String())
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if len(order) != 2 || order[0] != m.Blocks[0].ID {
		t.Fatalf("unexpected order: %v", order)
	}
}

func TestTranslationStageResumesPersistedProgressAfterRestart(t *testing.T) {
	for _, phase := range []string{"settling", "translating"} {
		t.Run(phase, func(t *testing.T) {
			s, p, m := translationFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET classification_status='done'"); err != nil {
				t.Fatal(err)
			}
			first := newTranslation(m.Blocks[0])
			first.Status = "complete"
			first.Sentences = []TranslationSentence{{Source: m.Blocks[0].Text, Target: "已保存译文"}}
			second := newTranslation(m.Blocks[1])
			second.Status = "running"
			for _, item := range []TranslationBlock{first, second} {
				if err := s.saveTranslation("doc", item); err != nil {
					t.Fatal(err)
				}
			}
			p.Phase, p.Status = phase, "running"
			p.TranslationsDone, p.TranslationsTotal = 0, 0
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			started := make(chan string, 1)
			release := make(chan struct{})
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				batch := readTranslationInput(t, r).Batch
				if len(batch.Paragraphs) != 1 {
					t.Error("regenerated completed translation")
					return
				}
				started <- batch.Paragraphs[0].BlockID
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
				finishTranslationStream(w)
			}))
			defer provider.Close()
			configureTranslationTest(t, s, provider.URL)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			stop := s.StartProcessing(ctx)
			defer stop()
			if id := waitTranslationSignal(t, started); id != second.BlockID {
				t.Fatalf("wrong pending paragraph: %s", id)
			}
			saved, err := s.Store.processing("doc")
			if err != nil || saved.Phase != "translating" || saved.TranslationsDone != 1 || saved.TranslationsTotal != 2 {
				t.Fatalf("did not restore progress from saved translations: %+v, %v", saved, err)
			}
			close(release)
			deadline := time.Now().Add(10 * time.Second)
			for {
				saved, err = s.Store.processing("doc")
				if err == nil && saved.Phase == "ready" && saved.Status == "complete" && saved.TranslationsDone == 2 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("translation stage did not finish: %+v, %v", saved, err)
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
}

func TestTranslationStageWaitsForTextCapabilityAndResumes(t *testing.T) {
	s, p, _ := translationFixture(t)
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Phase != "translating" || p.Status != "waiting" || p.TranslationsDone != 0 || p.TranslationsTotal != 2 {
		t.Fatalf("wrong translation waiting state: %+v", p)
	}
	s.wakeProcessing()
	saved, err := s.Store.processing("doc")
	if err != nil || saved.Phase != "translating" || saved.Status != "queued" || saved.TranslationsTotal != 2 {
		t.Fatalf("configuration wake lost translation stage: %+v, %v", saved, err)
	}
}

func TestAlgorithmImagesNeverEnterTranslationQueue(t *testing.T) {
	for _, image := range []string{"", "assets/p7-b9.png"} {
		b := PDFBlock{ID: "p7-b9", Page: 7, Label: "algorithm", Text: "Algorithm 1: Read phase\n1 Function read(txn, record)", Image: image}
		m := layoutManifest{Blocks: []PDFBlock{b}}
		if len(m.translationParagraphs()) != 0 || len(m.translationItems()) != 0 {
			t.Fatalf("algorithm queued for translation: %+v", b)
		}
	}
}

func TestAlgorithmCaptionUsesImageTranslationRules(t *testing.T) {
	b := PDFBlock{ID: "p7-b9", Page: 7, Label: "algorithm", Text: "Function read(txn, record)", Caption: "Algorithm 1: Read phase", Image: "assets/p7-b9.png"}
	if translationSource(b) != b.Caption {
		t.Fatal("algorithm did not use the image caption path")
	}
}
