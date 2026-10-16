package reader

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
)

func paperDoc(t *testing.T, s *Server, data []byte) Document {
	t.Helper()
	w := uploadTo(t, s, "papers", "paper.pdf", data)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	return d
}
func assistanceRequest(t *testing.T, s *Server, action string) Processing {
	t.Helper()
	s.Token = "test-secret"
	body, _ := json.Marshal(map[string]any{"action": action})
	w := request(t, s, "POST", "/api/documents/doc/assistance", strings.NewReader(string(body)))
	if w.Code != 200 {
		t.Fatalf("%s: %d %s", action, w.Code, w.Body.String())
	}
	var p Processing
	if e := json.Unmarshal(w.Body.Bytes(), &p); e != nil {
		t.Fatal(e)
	}
	return p
}
func TestAssistancePauseSurvivesRestart(t *testing.T) {
	s, p := processingFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var got Processing
	p = assistanceRequest(t, s, "start")
	if !p.Enabled || p.Status != "queued" {
		t.Fatalf("wrong scope: %+v", p)
	}
	p = assistanceRequest(t, s, "pause")
	s.StartProcessing(ctx)()
	got, _ = s.Store.processing("doc")
	if got.Enabled || got.Status != "paused" {
		t.Fatalf("pause lost on restart: %+v", got)
	}
	if r := request(t, s, "POST", "/api/documents/doc/processing", nil); r.Code != 409 {
		t.Fatal("retry enabled a paused task")
	}
}
func TestAssistanceJoinsProcessingWithoutCancellingChat(t *testing.T) {
	s, p := processingFixture(t)
	s.Token = "test-secret"
	_ = s.Store.saveProcessing(p)
	ctx, cancel := context.WithCancel(context.Background())
	task := &documentTask{cancel: cancel, done: make(chan struct{})}
	s.activeProcessing = map[string]*documentTask{"doc": task}
	chat, finish, e := s.beginDocumentTask(context.Background(), "doc")
	if e != nil {
		t.Fatal(e)
	}
	defer finish()
	go func() {
		<-ctx.Done()
		p.Status = "failed"
		p.Enabled = true
		_ = s.Store.saveProcessing(p)
		s.finishProcessingTask("doc", task)
	}()
	got := assistanceRequest(t, s, "pause")
	if got.Enabled || got.Status != "paused" {
		t.Fatalf("stale worker overwrote pause: %+v", got)
	}
	if chat.Err() != nil {
		t.Fatal("paused the independent chat")
	}
}
func TestWholeDocumentTranslationReusesCachedResults(t *testing.T) {
	s, _, m := translationFixture(t)
	m.Pages = 20
	outside := m.Blocks[0]
	outside.ID = "p9-b1"
	outside.Page = 9
	m.Blocks = append(m.Blocks, outside)
	raw, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), raw, 0600)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		input := readTranslationInput(t, r)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, paragraph := range input.Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(paragraph))
		}
		finishTranslationStream(w)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	p := assistanceRequest(t, s, "start")
	if e := s.learnPDF(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	if e := s.processTranslation(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	before := calls.Load()
	if before != 1 {
		t.Fatalf("calls=%d", before)
	}
	p = assistanceRequest(t, s, "start")
	if e := s.learnPDF(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	if e := s.processTranslation(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != before {
		t.Fatal("revisited page generated again")
	}
	items, _ := s.translations("doc", m)
	if items[len(items)-1].Status != "complete" {
		t.Fatal("whole document did not finish")
	}
	if w := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p9-b1"}`)); w.Code != 202 {
		t.Fatal("explicit cached paragraph request failed")
	}
}
func TestImportWithAutoTranslationDisabledDoesNotStartBackgroundAI(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	if w := request(t, s, "PUT", "/api/settings", strings.NewReader(`{"autoTranslatePDF":false}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	d := paperDoc(t, s, sample(t, "reading-notes.pdf"))
	p, e := s.Store.processing(d.ID)
	if e != nil || !p.Enabled || p.Status != "queued" || p.AutoTranslateMaxPages == nil || *p.AutoTranslateMaxPages != 0 {
		t.Fatalf("import must queue local parsing only: %+v %v", p, e)
	}
}

func TestFullProcessingRetainsEarlierOCRWarnings(t *testing.T) {
	s, p := processingFixture(t)
	m, _ := s.readLayout("doc")
	m.Pages = 10
	m.IncompletePages = []int{1}
	m.Warnings = []string{"第 1 页无可提取文字；尚未接入 OCR，正文不完整。"}
	data, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600)
	if e := s.learnPDF(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	if !p.Incomplete {
		t.Fatal("whole-book status forgot an earlier scanned page")
	}
}

func TestImportAutoTranslationPreferenceOnlyAffectsNewDocuments(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	if w := request(t, s, "PUT", "/api/settings", strings.NewReader(`{"autoTranslatePDF":false}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	first := paperDoc(t, s, sample(t, "reading-notes.pdf"))
	for _, enabled := range []bool{true, false} {
		body, _ := json.Marshal(map[string]any{"autoTranslatePDF": enabled, "appearance": "dark"})
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(string(body)))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		settings := request(t, s, "GET", "/api/settings", nil)
		var saved map[string]any
		if err := json.Unmarshal(settings.Body.Bytes(), &saved); err != nil || saved["autoTranslatePDF"] != enabled || saved["appearance"] != "dark" {
			t.Fatalf("settings not persisted: %s", settings.Body.String())
		}
		content := append(sample(t, "reading-notes.pdf"), []byte("\n% preference "+string(body))...)
		next := paperDoc(t, s, content)
		p, err := s.Store.processing(next.ID)
		if err != nil || !p.Enabled || p.Status != "queued" || p.AutoTranslateMaxPages == nil || (*p.AutoTranslateMaxPages > 0) != enabled {
			t.Fatalf("preference ignored: %+v %v", p, err)
		}
		original, _ := s.Store.processing(first.ID)
		if original.AutoTranslateMaxPages == nil || *original.AutoTranslateMaxPages != 0 {
			t.Fatal("changing preference enabled an existing document")
		}
	}
	if w := request(t, s, "PUT", "/api/settings", strings.NewReader(`{"autoTranslatePDF":"true"}`)); w.Code != 400 {
		t.Fatal("non-boolean preference accepted")
	}
}

func TestPausedParallelProgressCannotReenableProcessing(t *testing.T) {
	s, p := processingFixture(t)
	p.Translating = &ProcessingStage{Status: "running"}
	p.Enabled, p.Status = false, "paused"
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	stale := p
	stale.Enabled, stale.lane, stale.Status = true, "translating", "queued"
	if err := s.Store.saveProcessing(stale); err != nil {
		t.Fatal(err)
	}
	s.wakeProcessing()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.StartProcessing(ctx)()
	got, _ := s.Store.processing("doc")
	if got.Enabled || got.Status != "paused" {
		t.Fatalf("parallel progress or recovery lost pause: %+v", got)
	}
}

func TestImportDefaultsToAutomaticTranslation(t *testing.T) {
	for _, settings := range []string{"", `{}`, `{"appearance":"dark"}`} {
		t.Run(settings, func(t *testing.T) {
			s := testServer(t)
			if settings != "" {
				if _, err := s.Store.DB.Exec("INSERT INTO settings(key,value) VALUES('reader',?)", settings); err != nil {
					t.Fatal(err)
				}
			}
			d := paperDoc(t, s, sample(t, "reading-notes.pdf"))
			p, err := s.Store.processing(d.ID)
			if err != nil || !p.Enabled || p.Status != "queued" {
				t.Fatalf("default did not queue translation: %+v %v", p, err)
			}
		})
	}
}

func TestStartupKeepsLegacyProcessingRunnable(t *testing.T) {
	s, _ := processingFixture(t)
	legacy := `{"documentId":"doc","phase":"translating","status":"queued","detail":"等待翻译正文","translating":{"status":"queued"}}`
	if _, err := s.Store.DB.Exec("UPDATE document_processing SET status='queued',body=? WHERE document_id='doc'", legacy); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.StartProcessing(ctx)()
	got, _ := s.Store.processing("doc")
	if !got.Enabled || got.Status != "queued" {
		t.Fatalf("legacy job was stranded: %+v", got)
	}
	s.Token = "test-secret"
	if r := request(t, s, "POST", "/api/documents/doc/processing", nil); r.Code != 200 {
		t.Fatalf("legacy retry: %d %s", r.Code, r.Body.String())
	}
}
