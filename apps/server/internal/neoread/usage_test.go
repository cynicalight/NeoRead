package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestUsageLedgerKeepsConcurrentFailuresSnapshotsAndRetries(t *testing.T) {
	s, p := processingFixture(t)
	sink := s.processingUsageSink(p.DocumentID, "settling", "p1-b1")
	call := UsageCall{ID: "first", Provider: "codex", StartedAt: now(), Status: "running", Models: []ModelTokens{{Model: "actual", Tokens: &TokenCounts{InputTokens: 10, OutputTokens: 5, TotalTokens: 15, CachedInputTokens: tokenCount(7), ReasoningOutputTokens: tokenCount(2)}}}}
	if err := sink(call); err != nil {
		t.Fatal(err)
	}
	call.Status = "failed"
	call.FinishedAt = now()
	if err := sink(call); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := UsageCall{ID: fmt.Sprint("retry", i), Provider: "image-api", StartedAt: now(), FinishedAt: now(), Status: "complete", Models: []ModelTokens{{Model: "backup", Tokens: &TokenCounts{InputTokens: 2, OutputTokens: 1, TotalTokens: 3}}}}
			if err := sink(c); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	call.ID = "unknown"
	call.Models = []ModelTokens{{Model: "", Tokens: nil}}
	if err := sink(call); err != nil {
		t.Fatal(err)
	}
	report, err := s.Store.usageReport("doc")
	if err != nil {
		t.Fatal(err)
	}
	if report.Total.TotalTokens != 33 || report.Total.InputTokens != 22 || report.Total.OutputTokens != 11 || (report.Total.CachedInputTokens == nil || *report.Total.CachedInputTokens != 7) || report.FailedCalls != 2 || report.PartialCalls != 1 || report.UnknownCalls != 1 || len(report.Calls) != 8 {
		t.Fatalf("%+v", report)
	}
	// A repeated snapshot must not count the same model's cumulative tokens twice.
	models := mergeModelTokens([]ModelTokens{{Model: "actual"}}, []ModelTokens{{Tokens: &TokenCounts{InputTokens: 1, OutputTokens: 2, TotalTokens: 3}}})
	models = mergeModelTokens(models, []ModelTokens{{Tokens: &TokenCounts{InputTokens: 2, OutputTokens: 4, TotalTokens: 6}}})
	if len(models) != 1 || models[0].Model != "actual" || models[0].Tokens.TotalTokens != 6 {
		t.Fatal(models)
	}
	// Durable through reopen, cascades with document deletion.
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	r, err := reopened.usageReport("doc")
	if err != nil || r.Total.TotalTokens != report.Total.TotalTokens {
		t.Fatal(r, err)
	}
	if _, err = s.Store.DB.Exec("DELETE FROM documents WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	var n int
	s.Store.DB.QueryRow("SELECT count(*) FROM processing_usage").Scan(&n)
	if n != 0 {
		t.Fatal(n)
	}
}
func TestUsageRecordsFallbackAndPreservesFailedUsage(t *testing.T) {
	s, _ := processingFixture(t)
	g := &GenerationService{primary: "codex", usageSink: s.processingUsageSink("doc", "settling", "p1-b1"), connections: map[string]generationConnection{
		"codex": {VerifiedText: true, VerifiedVision: true, Adapter: adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			emit(ProviderEvent{Metrics: []ModelTokens{{Model: "primary", Tokens: &TokenCounts{InputTokens: 4, OutputTokens: 1, TotalTokens: 5}}}})
			return GenerateResult{}, errors.New("upstream")
		})},
		"image-api": {VerifiedText: true, VerifiedVision: true, Adapter: adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			emit(ProviderEvent{Metrics: []ModelTokens{{Model: "backup", Tokens: &TokenCounts{InputTokens: 8, OutputTokens: 2, TotalTokens: 10}}}})
			emit(ProviderEvent{Text: "answer"})
			return GenerateResult{Text: "answer", FinishReason: "stop"}, nil
		})},
	}}
	result, err := g.Generate(t.Context(), AIInput{Image: []byte("png")}, false, nil)
	if err != nil || !result.Fallback {
		t.Fatal(result, err)
	}
	r, err := s.Store.usageReport("doc")
	if err != nil || len(r.Calls) != 2 || r.Total.TotalTokens != 15 || r.UnknownCalls != 0 || r.PartialCalls != 1 {
		t.Fatal(r, err)
	}
}
func TestUsageUnknownHistoryAndInterruptedAttempt(t *testing.T) {
	s, p := processingFixture(t)
	p.UsageTracked = false
	s.Store.saveProcessing(p)
	sink := s.processingUsageSink("doc", "translating", "p1-b1")
	sink(UsageCall{ID: "open", Provider: "kimi", StartedAt: now(), Status: "running", Models: []ModelTokens{{Model: "kimi", Tokens: nil}}})
	if err := s.Store.recoverUsage(); err != nil {
		t.Fatal(err)
	}
	r, err := s.Store.usageReport("doc")
	if err != nil || r.HistoryComplete || r.UnknownCalls != 1 || r.Calls[0].Status != "interrupted" {
		t.Fatal(r, err)
	}
	s.Token = "test-secret"
	response := request(t, s, "GET", "/api/documents/doc/processing-usage", nil)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
}
func TestAPIUsageOnlyFrameAfterFinishIsNotText(t *testing.T) {
	wire := `data: {"model":"actual-api","choices":[{"index":0,"delta":{"content":"answer"}}]}` + "\n\n" + `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n" + `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":1}}}` + "\n\n" + "data: [DONE]\n\n"
	var models []ModelTokens
	var text string
	result, err := readCompletionStream(t.Context(), strings.NewReader(wire), func(event ProviderEvent) error {
		models = mergeModelTokens(models, event.Metrics)
		text += event.Text
		return nil
	})
	if err != nil || result.Text != "answer" || text != "answer" || len(models) != 1 || models[0].Model != "actual-api" || models[0].Tokens.TotalTokens != 13 {
		t.Fatal(result, models, err)
	}
	if completionTokens(&completionUsage{}) != nil {
		t.Fatal("missing counts became zero")
	}
}
func TestUsageStorageFailureDoesNotTriggerFallback(t *testing.T) {
	attempts := 0
	g := &GenerationService{primary: "codex", usageSink: func(UsageCall) error { return errors.New("storage unavailable") }, connections: map[string]generationConnection{}}
	for _, provider := range []string{"codex", "text-api"} {
		g.connections[provider] = generationConnection{VerifiedText: true, Adapter: adapterFunc(func(context.Context, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error) {
			attempts++
			return GenerateResult{}, nil
		})}
	}
	_, err := g.Generate(t.Context(), AIInput{}, false, nil)
	if errorKind(err) != ErrorSave || attempts != 0 {
		t.Fatal(err, attempts)
	}
}

func TestChatUsageRecordsTextAndImageAndSeparatesProcessing(t *testing.T) {
	s, _ := imageFixture(t)
	fakePiConnection(t, s, "codex", "")
	for _, body := range []string{`{"provider":"codex","prompt":"explain","context":""}`, `{"provider":"codex","prompt":"describe image","context":"","attachments":["p1-b1"]}`} {
		res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
		if !strings.Contains(res.Body.String(), "event: done") {
			t.Fatal(res.Body.String())
		}
	}
	r, err := s.Store.scopedUsageReport("doc", true)
	if err != nil || !r.HistoryComplete || len(r.Calls) != 2 || r.Total.TotalTokens != 60 || r.Calls[0].Target == r.Calls[1].Target || r.Calls[0].Models[0].Model != "fixture" {
		t.Fatal(r, err)
	}
	processing, err := s.Store.usageReport("doc")
	if err != nil || len(processing.Calls) != 0 || processing.Total.TotalTokens != 0 {
		t.Fatal(processing, err)
	}
	// EPUB chat reporting needs no PDF processing task.
	if _, err = s.Store.DB.Exec("DELETE FROM document_processing WHERE document_id='doc'"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.DB.Exec("UPDATE documents SET type='epub' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	res := request(t, s, "GET", "/api/documents/doc/chat-usage", nil)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	var apiReport UsageReport
	if err = json.Unmarshal(res.Body.Bytes(), &apiReport); err != nil || apiReport.Total.TotalTokens != 60 {
		t.Fatal(apiReport, err)
	}
	// Clearing conversation text must not erase usage that already occurred.
	s.Store.DB.Exec("DELETE FROM messages WHERE document_id='doc'")
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	r, err = reopened.scopedUsageReport("doc", true)
	if err != nil || !r.HistoryComplete || r.Total.TotalTokens != 60 {
		t.Fatal(r, err)
	}
	s.Store.DB.Exec("DELETE FROM documents WHERE id='doc'")
	var n int
	s.Store.DB.QueryRow("SELECT count(*) FROM processing_usage").Scan(&n)
	if n != 0 {
		t.Fatal(n)
	}
	s.Store.DB.QueryRow("SELECT count(*) FROM chat_usage_coverage").Scan(&n)
	if n != 0 {
		t.Fatal(n)
	}
}
func TestChatUsageMigrationAndDocumentIsolation(t *testing.T) {
	s, p := processingFixture(t)
	if err := s.Store.saveMessage(Message{DocumentID: p.DocumentID, Role: "assistant", Content: "old"}); err != nil {
		t.Fatal(err)
	}
	// Simulate a library from before chat usage was introduced.
	s.Store.DB.Exec("DELETE FROM chat_usage_coverage")
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	r, err := reopened.scopedUsageReport(p.DocumentID, true)
	if err != nil || r.HistoryComplete {
		t.Fatal(r, err)
	}
	stamp := now()
	if _, err = s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at) VALUES('other','epub','other','',0,?,?)", stamp, stamp); err != nil {
		t.Fatal(err)
	}
	sink := s.processingUsageSink(p.DocumentID, "chat", "request")
	if err = sink(UsageCall{ID: "failed-chat", Status: "failed", StartedAt: stamp, FinishedAt: stamp, Models: []ModelTokens{{Model: "actual", Tokens: &TokenCounts{InputTokens: 2, OutputTokens: 1, TotalTokens: 3}}}}); err != nil {
		t.Fatal(err)
	}
	r, err = s.Store.scopedUsageReport(p.DocumentID, true)
	if err != nil || r.Total.TotalTokens != 3 || r.FailedCalls != 1 || r.PartialCalls != 1 || r.HistoryComplete {
		t.Fatal(r, err)
	}
	other, err := s.Store.scopedUsageReport("other", true)
	if err != nil || len(other.Calls) != 0 || other.Total.TotalTokens != 0 || !other.HistoryComplete {
		t.Fatal(other, err)
	}
}
