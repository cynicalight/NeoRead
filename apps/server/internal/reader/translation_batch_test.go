package reader

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func configureTranslationTest(t *testing.T, s *Server, url string) {
	t.Helper()
	c := AIConfig{Primary: "codex", Models: map[string]string{}, TextAPI: APIConnection{URL: url, Model: "test"}, Capabilities: map[string]Capability{}}
	c.Capabilities["text-api"] = Capability{Text: true, Fingerprint: configPrint(c, "text-api")}
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
}
func translationParagraphLine(p translationParagraph) string {
	data, _ := json.Marshal(map[string]any{"blockId": p.BlockID, "sourceHash": p.SourceHash, "sentences": []TranslationSentence{{Source: p.Source, Target: "译文。"}}})
	return string(data) + "\n"
}
func translationLine(b PDFBlock) string {
	return translationParagraphLine(translationParagraph{b.ID, translationHash(translationSource(b)), translationSource(b)})
}

type translationTestInput struct {
	Title       string           `json:"title"`
	Author      string           `json:"author"`
	FrontMatter []string         `json:"frontMatter"`
	Batch       translationBatch `json:"batch"`
}

func readTranslationInput(t *testing.T, r *http.Request) translationTestInput {
	t.Helper()
	var request struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		t.Error(err)
		return translationTestInput{}
	}
	prompt := request.Messages[len(request.Messages)-1].Content
	_, raw, ok := strings.Cut(prompt, "输入资料：\n")
	if !ok {
		t.Error("missing batch input")
		return translationTestInput{}
	}
	var input translationTestInput
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		t.Error(err)
	}
	return input
}
func TestTranslationBatchBoundariesAndContext(t *testing.T) {
	m := layoutManifest{}
	for i, source := range []string{"一二三四五六七", "八九十甲乙丙丁", "第三段", "第四段", "第五段"} {
		m.Blocks = append(m.Blocks, PDFBlock{ID: fmt.Sprintf("p1-b%d", i+1), Page: 1, Label: "text", Text: source})
	}
	items := []TranslationBlock{}
	for _, b := range m.Blocks {
		items = append(items, newTranslation(b))
	}
	batches := translationBatches(m, items, 10)
	if len(batches) != 2 || len(batches[0].Paragraphs) != 2 || batches[0].Paragraphs[1].Source != "八九十甲乙丙丁" {
		t.Fatalf("split paragraph or counted UTF-8 bytes: %+v", batches)
	}
	if len(batches[0].After) != 2 || len(batches[1].Before) != 2 {
		t.Fatalf("missing context: %+v", batches)
	}
	items[0].Status = "complete"
	retry := translationBatches(m, items, 10)
	if len(retry[0].Paragraphs) != 1 || retry[0].Paragraphs[0].BlockID != m.Blocks[1].ID || retry[0].After[0].BlockID != m.Blocks[2].ID {
		t.Fatal("retry changed boundaries or regenerated completed text")
	}
	prompt := translationPrompt(Document{Title: "论文标题", Author: "作者"}, m, batches[0], "")
	if !strings.Contains(prompt, `"title":"论文标题"`) || !strings.Contains(prompt, `"author":"作者"`) {
		t.Fatal("metadata not attached")
	}
}
func TestTranslationJSONLPublishesOnlyCompleteValidatedLines(t *testing.T) {
	p := translationParagraph{"p1-b1", "version", "Sentence."}
	var saved []TranslationBlock
	d := newTranslationJSONL(translationBatch{Paragraphs: []translationParagraph{p}}, func(b TranslationBlock) error { saved = append(saved, b); return nil })
	line := translationParagraphLine(p)
	for _, chunk := range []string{`{"oops":`, "\n", strings.Replace(line, "version", "wrong", 1), strings.Replace(line, "p1-b1", "p1-b9", 1), line[:len(line)-1]} {
		if err := d.feed(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if len(saved) != 0 {
		t.Fatal("published invalid or incomplete line")
	}
	if err := d.feed("\n" + line); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved[0].BlockID != p.BlockID {
		t.Fatalf("line not published immediately or duplicate overwritten: %+v", saved)
	}
}
func sendTranslationDelta(w http.ResponseWriter, text string) {
	data, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": text}}}})
	fmt.Fprintf(w, "data: %s\n\n", data)
	w.(http.Flusher).Flush()
}
func finishTranslationStream(w http.ResponseWriter) {
	fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	w.(http.Flusher).Flush()
}
func waitTranslationSignal(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case id := <-ch:
		return id
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
		return ""
	}
}
func TestTranslationRunsThreeBatchesAndSavesBeforeProviderCompletes(t *testing.T) {
	s, p, m := translationFixture(t)
	m.Blocks = append(m.Blocks, m.Blocks[1], m.Blocks[1])
	m.Blocks[2].ID = "p1-b3"
	m.Blocks[3].ID = "p1-b4"
	for i := range m.Blocks {
		m.Blocks[i].Text = strings.Repeat(fmt.Sprintf("段%d", i), 5001)
	}
	started := make(chan string, 4)
	released := make(chan struct{})
	defer close(released)
	var active, maxActive atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		n := active.Add(1)
		defer active.Add(-1)
		for old := maxActive.Load(); n > old; old = maxActive.Load() {
			if maxActive.CompareAndSwap(old, n) {
				break
			}
		}
		started <- batch.Paragraphs[0].BlockID
		w.Header().Set("Content-Type", "text/event-stream")
		sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
		select {
		case <-released:
		case <-r.Context().Done():
			return
		}
		finishTranslationStream(w)
	}))
	// Close release before the HTTP server so blocked handlers cannot hang cleanup.
	t.Cleanup(provider.Close)
	configureTranslationTest(t, s, provider.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.settleTranslations(ctx, &p, m) }()
	first, second, third := waitTranslationSignal(t, started), waitTranslationSignal(t, started), waitTranslationSignal(t, started)
	if first == second || first == third || second == third || first == "p1-b4" || second == "p1-b4" || third == "p1-b4" {
		t.Fatalf("bad batch scheduling: %s %s %s", first, second, third)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		items, err := s.translations("doc", m)
		if err != nil {
			t.Fatal(err)
		}
		if items[0].Status == "complete" && items[1].Status == "complete" && items[2].Status == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("paragraphs waited for provider completion")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-started:
		t.Fatal("started a fourth concurrent batch")
	default:
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("workers ignored cancellation")
	}
	items, _ := s.translations("doc", m)
	if maxActive.Load() != 3 || items[0].Status != "complete" || items[1].Status != "complete" || items[2].Status != "complete" || items[3].Status != "pending" {
		t.Fatalf("lost partial results or exceeded concurrency: max=%d %+v", maxActive.Load(), items)
	}
	saved, err := s.Store.processing("doc")
	if err != nil || saved.Phase != "translating" || saved.TranslationsDone != 3 || saved.TranslationsTotal != 4 {
		t.Fatalf("streamed progress was not persisted: %+v, %v", saved, err)
	}
}
func TestTranslationSubscriptionSnapshotAndLiveLine(t *testing.T) {
	s, _, m := translationFixture(t)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/documents/doc/translations/stream", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scan := bufio.NewScanner(res.Body)
	next := func() string {
		t.Helper()
		for scan.Scan() {
			if strings.HasPrefix(scan.Text(), "data: ") {
				return strings.TrimPrefix(scan.Text(), "data: ")
			}
		}
		t.Fatalf("stream ended: %v", scan.Err())
		return ""
	}
	if !strings.Contains(next(), `"pending"`) {
		t.Fatal("missing initial snapshot")
	}
	t1 := newTranslation(m.Blocks[0])
	t1.Status = "complete"
	t1.Sentences = []TranslationSentence{{Source: m.Blocks[0].Text, Target: "译文"}}
	if err = s.saveTranslation("doc", t1); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(next(), `"complete"`) {
		t.Fatal("saved line not pushed")
	}
	cancel()
	res.Body.Close()
	req, _ = http.NewRequest("GET", server.URL+"/api/documents/doc/translations/stream", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scan = bufio.NewScanner(res.Body)
	if !strings.Contains(next(), `"complete"`) {
		t.Fatal("reconnect lost committed paragraph")
	}
}
func TestTranslationTruncatedBatchRetainsRowsAndRetriesOnlyMissing(t *testing.T) {
	s, p, m := translationFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
			tail := translationParagraphLine(batch.Paragraphs[1])
			sendTranslationDelta(w, tail[:len(tail)/2])
			return // Upstream disconnects without a successful terminal event.
		}
		if len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != m.Blocks[1].ID {
			t.Errorf("regenerated completed row: %+v", batch.Paragraphs)
		}
		sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
		finishTranslationStream(w)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err == nil {
		t.Fatal("truncated batch reported complete")
	}
	items, _ := s.translations("doc", m)
	if items[0].Status != "complete" || items[1].Status != "failed" {
		t.Fatalf("partial progress lost: %+v", items)
	}
	p.Status = "failed"
	_ = s.Store.saveProcessing(p)
	if res := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p1-b2"}`)); res.Code != 202 {
		t.Fatal(res.Body.String())
	}
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err != nil {
		t.Fatal(err)
	}
	items, _ = s.translations("doc", m)
	if calls.Load() != 2 || items[0].Status != "complete" || items[1].Status != "complete" {
		t.Fatal("resume failed")
	}
}
func TestTranslationDeadlineDoesNotChangeChatDeadline(t *testing.T) {
	for _, timeout := range []time.Duration{0, translationBatchTimeout} {
		service := &GenerationService{primary: "codex", timeout: timeout, connections: map[string]generationConnection{}}
		service.connections["codex"] = generationConnection{VerifiedText: true, Adapter: adapterFunc(func(ctx context.Context, _ GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			deadline, ok := ctx.Deadline()
			want := timeout
			if want == 0 {
				want = 3 * time.Minute
			}
			if !ok || time.Until(deadline) > want || time.Until(deadline) < want-time.Second {
				t.Errorf("unexpected timeout: %v", time.Until(deadline))
			}
			if err := emit(ProviderEvent{Text: "ok"}); err != nil {
				return GenerateResult{}, err
			}
			return GenerateResult{Text: "ok", FinishReason: "stop"}, nil
		})}
		if _, err := service.Generate(context.Background(), AIInput{}, false, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTranslationJSONLRepairsUnescapedLatexBackslashes(t *testing.T) {
	p := translationParagraph{"p1-b2", "h2", "Two."}
	var got TranslationBlock
	d := newTranslationJSONL(translationBatch{Paragraphs: []translationParagraph{p}}, func(block TranslationBlock) error {
		got = block
		return nil
	})
	line := `{"blockId":"p1-b2","sourceHash":"h2","sentences":[{"source":"Two.","target":"$\pi$、$\eta$、$\ll$、$\log n$"}]}`
	if err := d.feed(line + "\n"); err != nil {
		t.Fatal(err)
	}
	if !d.completed[p.BlockID] || len(got.Sentences) != 1 || got.Sentences[0].Target != `$\pi$、$\eta$、$\ll$、$\log n$` {
		t.Fatalf("unescaped LaTeX was not repaired: decoder=%+v block=%+v", d, got)
	}
}

func TestRepairInvalidJSONEscapesPreservesValidEscapesAndOutsideText(t *testing.T) {
	valid := `{"target":"quote: \" newline: \n unicode: \u03c0 slash: \\ solidus: \/"}`
	if got, changed := repairInvalidJSONEscapes(valid); changed || got != valid {
		t.Fatalf("valid JSON changed: changed=%v %q", changed, got)
	}
	broken := `{"target":"$\pi$"}\tail`
	want := `{"target":"$\\pi$"}\tail`
	if got, changed := repairInvalidJSONEscapes(broken); !changed || got != want {
		t.Fatalf("wrong repair: changed=%v got=%q want=%q", changed, got, want)
	}
}

func TestTranslationJSONLNamesStructurallyBrokenLines(t *testing.T) {
	a, b := translationParagraph{"p1-b1", "h1", "One."}, translationParagraph{"p1-b2", "h2", "Two."}
	d := newTranslationJSONL(translationBatch{Paragraphs: []translationParagraph{a, b}}, func(TranslationBlock) error { return nil })
	for _, line := range []string{"```jsonl", `{"blockId":"p1-b2","sourceHash":"h2","sentences":`, translationParagraphLine(a)} {
		if err := d.feed(strings.TrimSuffix(line, "\n") + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.HasPrefix(d.invalid["p1-b2"], "第 2 行不是合法的 JSON") || d.malformed != 1 || !strings.HasPrefix(d.firstMalformed, "第 1 行") || !d.completed["p1-b1"] {
		t.Fatalf("broken lines not attributed: %+v %d %q", d.invalid, d.malformed, d.firstMalformed)
	}
}
func TestTranslationAsksOnceMoreForParagraphsTheModelSkipped(t *testing.T) {
	s, p, m := translationFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		if calls.Add(1) == 2 && (len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != m.Blocks[1].ID) {
			t.Errorf("follow-up did not ask for the skipped paragraph only: %+v", batch.Paragraphs)
		}
		// The model ends normally after the first paragraph it was given.
		writeAPIReply(w, translationParagraphLine(batch.Paragraphs[0]))
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err != nil {
		t.Fatal(err)
	}
	items, _ := s.translations("doc", m)
	if calls.Load() != 2 || items[0].Status != "complete" || items[1].Status != "complete" {
		t.Fatalf("skipped paragraph not recovered: calls=%d %+v", calls.Load(), items)
	}
	if _, err := os.Stat(filepath.Join(s.Store.Root, "cache", "doc", "translation-failures")); !os.IsNotExist(err) {
		t.Fatal("recorded a failure for a recovered batch")
	}
}
func TestTranslationFailureNamesTheCauseAndKeepsTheOutput(t *testing.T) {
	s, p, m := translationFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		text := "not json at all\n"
		if len(batch.Paragraphs) == 2 {
			text = translationParagraphLine(batch.Paragraphs[0])
		}
		writeAPIReply(w, text)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err == nil {
		t.Fatal("unrecovered paragraph reported complete")
	}
	items, _ := s.translations("doc", m)
	want := "补译后仍未完成：模型只返回了 0/1 段，另有 1 行无法解析（第 1 行不是合法的 JSON"
	if items[0].Status != "complete" || items[1].Status != "failed" || !strings.HasPrefix(items[1].Error, want) {
		t.Fatalf("failure cause not recorded: %+v", items[1])
	}
	dir := filepath.Join(s.Store.Root, "cache", "doc", "translation-failures")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("diagnostic not written: %v %v", entries, err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	cut := strings.Index(string(data), "--- raw output ---")
	if cut < 0 || !strings.Contains(string(data)[:cut], "=== attempt 2:") {
		t.Fatal("trusted retry statistics must precede all model output")
	}
	for _, part := range []string{"batch: p1-b1…p1-b2 (2 paragraphs)", "failed p1-b2: " + want, "=== attempt 2: 1 paragraphs requested, 0 saved, 1 output lines, 1 unparsable", "not json at all"} {
		if !strings.Contains(string(data), part) {
			t.Fatalf("diagnostic misses %q:\n%s", part, data)
		}
	}
	// Only the most recent diagnostics are kept.
	batch := translationBatch{Paragraphs: []translationParagraph{{BlockID: "p1-b2"}}}
	attempt := &translationAttempt{decoder: newTranslationJSONL(batch, nil)}
	for i := 0; i < translationFailureLogs+2; i++ {
		s.recordTranslationFailure("doc", batch, []*translationAttempt{attempt}, []TranslationBlock{{BlockID: "p1-b2", Error: "x"}})
	}
	if entries, _ = os.ReadDir(dir); len(entries) != translationFailureLogs {
		t.Fatalf("kept %d diagnostics", len(entries))
	}
}
