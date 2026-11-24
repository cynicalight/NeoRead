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
)

func processingFixture(t *testing.T) (*Server, Processing) {
	t.Helper()
	store, e := OpenStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { store.DB.Close() })
	_, e = store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES('doc','pdf','test','',1,?,?,'papers')", now(), now())
	if e != nil {
		t.Fatal(e)
	}
	s := NewServer(store, "test", "")
	d, _ := store.Document("doc")
	if e = store.enqueueDocument(d); e != nil {
		t.Fatal(e)
	}
	p, _ := store.processing("doc")
	// Translation lifecycle tests start from an explicitly enabled job, not the import threshold.
	p.Enabled, p.AutoTranslateMaxPages = true, nil
	p.Status = "queued"
	if e = store.saveProcessing(p); e != nil {
		t.Fatal(e)
	}
	dir := s.analysisDir("doc")
	if e = os.MkdirAll(filepath.Join(dir, "assets"), 0700); e != nil {
		t.Fatal(e)
	}
	b := PDFBlock{ID: "p1-b1", Page: 1, Label: "chart", Image: "assets/p1-b1.png"}
	b.Bounds.X = .1
	b.Bounds.Y = .1
	b.Bounds.Width = .3
	b.Bounds.Height = .4
	data, _ := json.Marshal(layoutManifest{Pages: 2, Blocks: []PDFBlock{b}})
	if e = os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0600); e != nil {
		t.Fatal(e)
	}
	return s, p
}
func TestLearningWithoutTextCompletesWithoutAttachmentWork(t *testing.T) {
	s, p := processingFixture(t)
	if e := s.learnPDF(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	if p.Phase != "ready" || p.Status != "complete" || p.PagesDone != 2 || p.CompletedAt == "" {
		t.Fatalf("wrong learning result: %+v", p)
	}
	m, e := s.readLayout("doc")
	if e != nil || len(m.Blocks) != 1 {
		t.Fatal("blocks unavailable")
	}
	if _, e = os.Stat(filepath.Join(s.analysisDir("doc"), "transcripts")); !os.IsNotExist(e) {
		t.Fatal("created an attachment transcript directory")
	}
}

// Image consolidation was removed: attachments never reach the vision provider,
// and transcripts saved by earlier versions stay untouched on disk.
func TestProcessingTranslatesWithoutConsolidatingAttachments(t *testing.T) {
	s, p := processingFixture(t)
	m, _ := s.readLayout("doc")
	m.Blocks[0].Caption = "Figure one."
	dir := s.analysisDir("doc")
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, m.Blocks[0].Image), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(dir, "transcripts", "p1-b1.md")
	_ = os.MkdirAll(filepath.Dir(legacy), 0700)
	if err := os.WriteFile(legacy, []byte("user-corrected transcript"), 0600); err != nil {
		t.Fatal(err)
	}
	var imageCalls atomic.Int32
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		imageCalls.Add(1)
		http.Error(w, "unexpected image call", http.StatusTeapot)
	}))
	defer images.Close()
	text := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, paragraph := range readTranslationInput(t, r).Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(paragraph))
		}
		finishTranslationStream(w)
	}))
	defer text.Close()
	configureFormulaTest(t, s, text.URL, images.URL)
	if err := s.learnPDF(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Phase != "translating" || p.Status != "queued" {
		t.Fatalf("translation not queued after learning: %+v", p)
	}
	if err := s.processTranslation(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Status != "complete" || p.Phase != "ready" || p.TranslationsDone != 1 {
		t.Fatalf("%+v", p)
	}
	if imageCalls.Load() != 0 {
		t.Fatal("attachment sent to the vision provider")
	}
	if data, _ := os.ReadFile(legacy); string(data) != "user-corrected transcript" {
		t.Fatal("legacy transcript changed")
	}
}
func TestLayoutRejectsEscapingAssetPath(t *testing.T) {
	s, _ := processingFixture(t)
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	data, _ := os.ReadFile(path)
	var m layoutManifest
	_ = json.Unmarshal(data, &m)
	m.Blocks[0].Image = "../../outside.png"
	data, _ = json.Marshal(m)
	_ = os.WriteFile(path, data, 0600)
	if _, e := s.readLayout("doc"); e == nil {
		t.Fatal("escaping path accepted")
	}
}
func TestProcessingInterruptedStateIsQueuedOnRestart(t *testing.T) {
	s, p := processingFixture(t)
	p.Status = "running"
	_ = s.Store.saveProcessing(p)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stop := s.StartProcessing(ctx)
	stop()
	saved, _ := s.Store.processing("doc")
	if saved.Status != "queued" {
		t.Fatalf("lost interrupted task: %+v", saved)
	}
}
func TestLibraryLockIsExclusive(t *testing.T) {
	root := t.TempDir()
	release, e := LockLibrary(root)
	if e != nil {
		t.Fatal(e)
	}
	if second, e := LockLibrary(root); e == nil {
		second()
		t.Fatal("second library writer admitted")
	}
	release()
	next, e := LockLibrary(root)
	if e != nil {
		t.Fatal(e)
	}
	next()
}
func TestPagesWithoutTextCompleteWithoutOCRWarnings(t *testing.T) {
	s, p := processingFixture(t)
	m := layoutManifest{Pages: 2, Blocks: []PDFBlock{}, Warnings: []string{"第 1 页无可提取文字；尚未接入 OCR，正文不完整。"}, IncompletePages: []int{1}}
	data, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600)
	if e := s.learnPDF(context.Background(), &p); e != nil {
		t.Fatal(e)
	}
	if p.Incomplete || p.Status != "complete" || p.Warning != "" || strings.Contains(p.Detail, "OCR") {
		t.Fatalf("empty page reported as incomplete: %+v", p)
	}
}

func TestLegacyNoTextStateIsNormalizedWithoutRestartingWork(t *testing.T) {
	s, p := processingFixture(t)
	s.Token = "test-secret"
	for _, state := range []string{"complete", "paused", "failed"} {
		p.Status = state
		p.Enabled = state != "paused"
		p.Incomplete = true
		p.Detail = "部分就绪：有页面缺少可提取文字，尚未接入 OCR"
		if state != "complete" {
			p.Detail = "保留任务状态"
		}
		p.Warning = "第 1 页无可提取文字；尚未接入 OCR，正文不完整。 第 2 页有未归入版面块的文字，已保留。"
		if _, err := s.Store.DB.Exec("UPDATE document_processing SET status=?,body=? WHERE document_id='doc'", state, jsonText(p)); err != nil {
			t.Fatal(err)
		}
		got, err := s.Store.processing("doc")
		if err != nil || got.Incomplete || got.Status != state || got.Enabled != p.Enabled || strings.Contains(got.Warning, "OCR") || !strings.Contains(got.Warning, "已保留") {
			t.Fatalf("legacy state: %+v %v", got, err)
		}
		if state != "complete" && got.Detail != p.Detail {
			t.Fatal("changed failure or pause detail")
		}
		response := request(t, s, "GET", "/api/processing", nil)
		if response.Code != 200 || strings.Contains(response.Body.String(), "OCR") || strings.Contains(response.Body.String(), `"incomplete":true`) {
			t.Fatal(response.Code, response.Body.String())
		}
	}
}
