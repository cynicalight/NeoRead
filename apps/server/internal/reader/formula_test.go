package reader

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFormulaMarkdownRequiresFormulaOnlyResponse(t *testing.T) {
	for _, valid := range []string{"$$\nx=1\n$$", "$$x=1$$\n\n$$y=2$$"} {
		if _, err := formulaMarkdown(valid); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []string{"只有解释", "$$ $$", "$$x$$\n$$ $$", "解释：$$x$$", "$$x$$\n解释", "```latex\n$$x$$\n```"} {
		if _, err := formulaMarkdown(invalid); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
}
func TestImageAssetsTranslateOnlyCaption(t *testing.T) {
	for _, label := range []string{"table", "image", "chart"} {
		b := PDFBlock{Label: label, Image: "assets/p1-b1.png", Text: "INTERNAL CELLS", Caption: "Table 5. Results."}
		if translationSource(b) != b.Caption {
			t.Fatal("caption missing")
		}
		b.Caption = ""
		if translationSource(b) != "" {
			t.Fatal("asset body leaked")
		}
	}
}
func formulaFixture(t *testing.T) (*Server, Processing, layoutManifest) {
	t.Helper()
	s, p := processingFixture(t)
	s.Token = "test-secret"
	m, _ := s.readLayout("doc")
	formula := m.Blocks[0]
	formula.Label = "display_formula"
	formula.Text = "FORMULA OCR"
	table := formula
	table.ID = "p1-b2"
	table.Label = "table"
	table.Image = "assets/p1-b2.png"
	table.Text = "INTERNAL CELLS"
	table.Caption = "Table 5. Results."
	m.Blocks = []PDFBlock{formula, table}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, b := range m.Blocks {
		if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), b.Image), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return s, p, m
}
func configureFormulaTest(t *testing.T, s *Server, textURL, imageURL string) {
	t.Helper()
	configureTranslationTest(t, s, textURL)
	config := s.aiConfig()
	config.ImageAPI = APIConnection{URL: imageURL, Model: "test"}
	config.Capabilities["image-api"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, "image-api")}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
}
func waitFormulaSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for concurrent provider")
	}
}
func TestFormulaConversionDoesNotBlockCaptionTranslation(t *testing.T) {
	s, p, m := formulaFixture(t)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	formulaStarted := make(chan struct{})
	textStarted := make(chan struct{})
	var imageCalls atomic.Int32
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		imageCalls.Add(1)
		var body struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		isMath := strings.Contains(string(body.Messages[len(body.Messages)-1].Content), "FORMULA OCR")
		w.Header().Set("Content-Type", "text/event-stream")
		if isMath {
			close(formulaStarted)
			sendTranslationDelta(w, "$$\nx_t=yx\n$$")
			w.(http.Flusher).Flush()
			<-release
		} else {
			t.Error("table attachment sent to the vision provider")
		}
		finishTranslationStream(w)
	}))
	defer images.Close()
	defer unblock()
	text := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(textStarted)
		input := readTranslationInput(t, r)
		if len(input.Batch.Paragraphs) != 1 || input.Batch.Paragraphs[0].Source != m.Blocks[1].Caption {
			t.Error("asset body sent to text translation")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, para := range input.Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(para))
		}
		finishTranslationStream(w)
	}))
	defer text.Close()
	configureFormulaTest(t, s, text.URL, images.URL)
	if err := s.learnPDF(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if p.TranslationsTotal != 2 {
		t.Fatalf("wrong translation total: %+v", p)
	}
	done := make(chan error, 1)
	go func() { done <- s.processTranslation(context.Background(), &p) }()
	waitFormulaSignal(t, formulaStarted)
	waitFormulaSignal(t, textStarted)
	deadline := time.Now().Add(10 * time.Second)
	for {
		items, err := s.translations("doc", m)
		if err != nil {
			t.Fatal(err)
		}
		if items[1].Status == "complete" {
			if items[0].Status != "running" || items[0].FormulaMarkdown != "" {
				t.Fatal("promoted partial formula before provider completion")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("caption blocked by slow formula")
		}
		time.Sleep(5 * time.Millisecond)
	}
	unblock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if p.Status != "complete" || p.TranslationsDone != 2 {
		t.Fatalf("%+v", p)
	}
	items, _ := s.translations("doc", m)
	if items[0].FormulaMarkdown != "$$\nx_t=yx\n$$\n" {
		t.Fatalf("%+v", items[0])
	}
	for _, relative := range []string{"formulas", "transcripts/p1-b1.md"} {
		if _, err := os.Stat(filepath.Join(s.analysisDir("doc"), relative)); !os.IsNotExist(err) {
			t.Fatalf("obsolete formula artifact: %s", relative)
		}
	}
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if imageCalls.Load() != 1 {
		t.Fatal("repeated completed formula conversion")
	}
}
func TestFormulaFailurePreservesCaptionAndCanRetry(t *testing.T) {
	s, p, m := formulaFixture(t)
	var valid atomic.Bool
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		response := "只有解释，没有公式"
		if valid.Load() {
			response = "$$\nx=1\n$$"
		}
		sendTranslationDelta(w, response)
		finishTranslationStream(w)
	}))
	defer images.Close()
	text := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input := readTranslationInput(t, r)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, para := range input.Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(para))
		}
		finishTranslationStream(w)
	}))
	defer text.Close()
	configureFormulaTest(t, s, text.URL, images.URL)
	if err := s.learnPDF(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(context.Background(), &p); err == nil {
		t.Fatal("accepted invalid math")
	}
	items, _ := s.translations("doc", m)
	if items[0].Status != "failed" || items[0].FormulaMarkdown != "" || items[1].Status != "complete" {
		t.Fatalf("%+v", items)
	}
	valid.Store(true)
	w := request(t, s, "POST", "/api/documents/doc/processing", nil)
	if w.Code != 200 {
		t.Fatalf("retry failed: %s", w.Body.String())
	}
	p, _ = s.Store.processing("doc")
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	items, _ = s.translations("doc", m)
	if items[0].Status != "complete" {
		t.Fatalf("%+v", items)
	}
}

func TestAssetBodyExcludedFromTranslationFrontMatter(t *testing.T) {
	m := layoutManifest{Blocks: []PDFBlock{{ID: "p1-b1", Page: 1, Label: "table", Text: "PRIVATE TABLE CELLS", Caption: "Table caption."}, {ID: "p1-b2", Page: 1, Label: "display_formula", Text: "FORMULA OCR"}}}
	prompt := translationPrompt(Document{Title: "Test"}, m, translationBatch{}, "")
	if strings.Contains(prompt, "PRIVATE TABLE CELLS") || strings.Contains(prompt, "FORMULA OCR") {
		t.Fatal("asset body leaked through metadata context")
	}
}

func TestFormulaCancellationResumesWithoutSavingPartialResult(t *testing.T) {
	s, _, m := formulaFixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		sendTranslationDelta(w, "$$x=1$$")
		w.(http.Flusher).Flush()
		close(started)
		<-release
		finishTranslationStream(w)
	}))
	defer images.Close()
	defer close(release)
	configureFormulaTest(t, s, images.URL, images.URL)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.convertFormulas(ctx, "doc", m) }()
	waitFormulaSignal(t, started)
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancellation was ignored")
	}
	items, _ := s.translations("doc", m)
	if items[0].Status != "pending" || items[0].FormulaMarkdown != "" {
		t.Fatalf("partial formula saved: %+v", items[0])
	}
}
