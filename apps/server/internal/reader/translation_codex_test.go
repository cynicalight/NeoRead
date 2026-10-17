package reader

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTranslationServiceKeepsOtherProviderTaskSettings(t *testing.T) {
	s, _, _ := translationFixture(t)
	config := AIConfig{
		Primary:            "claude",
		Models:             map[string]string{"claude": "chat-model", "codex": "chat-codex"},
		TranslationModels:  map[string]string{"claude": "translation-model", "codex": "selected-codex"},
		TranslationEfforts: map[string]map[string]string{"claude": {"translation-model": "low"}},
	}
	service, adapter := s.translationService(config)
	defer adapter.close()
	claude, ok := service.connections["claude"].Adapter.(configuredCLIAdapter)
	if !ok || service.primary != "claude" || claude.model != "translation-model" || claude.level != "low" || claude.task != taskTranslation {
		t.Fatalf("translation task settings not preserved: %#v", service)
	}
	if service.connections["codex"].Adapter != adapter.codex || config.Models["codex"] != "chat-codex" || config.TranslationModels["codex"] != "selected-codex" {
		t.Fatal("Codex adapter or saved model settings changed")
	}
}

func runTranslationSessionProcess() {
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), maxProviderFrame)
	enc := json.NewEncoder(os.Stdout)
	turn := 0
	model := ""
	for scan.Scan() {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scan.Bytes(), &req) != nil {
			os.Exit(1)
		}
		f, err := os.OpenFile(os.Getenv("READER_TRANSLATION_CAPTURE"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			os.Exit(2)
		}
		_ = json.NewEncoder(f).Encode(map[string]any{"pid": os.Getpid(), "method": req.Method, "params": req.Params})
		_ = f.Close()
		reply := func(v any) { _ = enc.Encode(map[string]any{"id": req.ID, "result": v}) }
		switch req.Method {
		case "initialize":
			reply(map[string]any{})
		case "thread/start":
			var params struct {
				Model string `json:"model"`
			}
			_ = json.Unmarshal(req.Params, &params)
			model = params.Model
			actual := model
			if actual == "" {
				actual = "cli-default"
			}
			reply(map[string]any{"thread": map[string]string{"id": "thread"}, "model": actual})
		case "turn/start":
			turn++
			tid := fmt.Sprintf("turn-%d", turn)
			reply(map[string]any{"turn": map[string]string{"id": tid}})
			notify := func(method string, p map[string]any) {
				p["threadId"] = "thread"
				p["turnId"] = tid
				_ = enc.Encode(map[string]any{"method": method, "params": p})
			}
			var params struct {
				Input []struct {
					Text string `json:"text"`
				} `json:"input"`
			}
			_ = json.Unmarshal(req.Params, &params)
			_, raw, _ := strings.Cut(params.Input[0].Text, "输入资料：\n")
			var input translationTestInput
			if json.Unmarshal([]byte(raw), &input) != nil {
				os.Exit(3)
			}
			if turn > 1 {
				_ = enc.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": "thread", "turnId": fmt.Sprintf("turn-%d", turn-1), "itemId": "old", "delta": "stale\n"}})
			}
			notify("thread/tokenUsage/updated", map[string]any{"tokenUsage": map[string]any{"total": TokenCounts{InputTokens: int64(turn * 20), OutputTokens: int64(turn * 10), TotalTokens: int64(turn * 30), CachedInputTokens: tokenCount(int64(turn * 8))}}})
			if os.Getenv("READER_TRANSLATION_FAIL_SECOND") == "1" && turn == 2 || os.Getenv("READER_TRANSLATION_FAIL_MODEL") == model && model != "" {
				notify("turn/completed", map[string]any{"turn": map[string]string{"id": tid, "status": "failed"}})
				continue
			}
			text := ""
			for _, p := range input.Batch.Paragraphs {
				text += translationParagraphLine(p)
			}
			notify("item/agentMessage/delta", map[string]any{"itemId": "answer", "delta": text})
			if os.Getenv("READER_TRANSLATION_CANCEL") == "1" {
				if !scan.Scan() {
					return
				}
				var interrupt struct {
					Method string `json:"method"`
				}
				_ = json.Unmarshal(scan.Bytes(), &interrupt)
				if interrupt.Method != "turn/interrupt" {
					os.Exit(4)
				}
				_ = os.WriteFile(os.Getenv("READER_AGENT_ACK"), []byte("interrupt"), 0600)
				return
			}
			notify("item/completed", map[string]any{"item": map[string]string{"id": "answer", "type": "agentMessage", "text": text}})
			notify("turn/completed", map[string]any{"turn": map[string]string{"id": tid, "status": "completed"}})
		}
	}
}

func TestTranslationCodexUsesMainAutomaticSelectionAndFallback(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		t.Run(fmt.Sprintf("fallback=%v", fallback), func(t *testing.T) {
			s, _, m, capture := translationSessionFixture(t)
			config := s.aiConfig()
			config.TranslationModels = nil
			config.TranslationEfforts = nil
			s.modelCache = map[string]modelCatalogEntry{"codex": {
				models:  []AgentModel{{ID: "gpt-6-luna", SupportedEfforts: []string{"low", "medium", "high"}}, {ID: "gpt-5.6-luna"}},
				expires: time.Now().Add(time.Minute),
			}}
			if fallback {
				t.Setenv("READER_TRANSLATION_FAIL_MODEL", "gpt-6-luna")
			}
			service, adapter := s.translationService(config)
			defer adapter.close()
			batch := translationBatch{Paragraphs: []translationParagraph{{BlockID: m.Blocks[0].ID, SourceHash: translationHash(m.Blocks[0].Text), Source: m.Blocks[0].Text}}}
			if _, err := service.Generate(t.Context(), AIInput{Prompt: translationPrompt(Document{}, m, batch, "")}, false, nil); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var selected []string
			for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
				var row struct {
					Method string `json:"method"`
					Params struct {
						Model  string `json:"model"`
						Effort string `json:"effort"`
					} `json:"params"`
				}
				if err := json.Unmarshal([]byte(line), &row); err != nil {
					t.Fatal(err)
				}
				if row.Method == "thread/start" {
					selected = append(selected, row.Params.Model)
				}
				if row.Method == "turn/start" && row.Params.Effort != "medium" {
					t.Fatalf("did not use default effort: %+v", row)
				}
			}
			if len(selected) == 0 || selected[0] != "gpt-6-luna" {
				t.Fatalf("wrong automatic model: %v", selected)
			}
			if fallback && (len(selected) != 2 || selected[1] != "") || !fallback && len(selected) != 1 {
				t.Fatalf("wrong fallback: %v", selected)
			}
		})
	}
}
func translationSessionFixture(t *testing.T) (*Server, Processing, layoutManifest, string) {
	t.Helper()
	fakeAgent(t, "codex", "translation-session")
	capture := filepath.Join(t.TempDir(), "requests.jsonl")
	t.Setenv("READER_TRANSLATION_CAPTURE", capture)
	s, p, m := translationFixture(t)
	s.modelCache = map[string]modelCatalogEntry{"codex": {models: []AgentModel{{ID: "selected-codex", SupportedEfforts: []string{"low", "medium", "high"}}}, expires: time.Now().Add(time.Minute)}}
	for i := range m.Blocks {
		m.Blocks[i].Text = strings.Repeat(fmt.Sprintf("Paragraph %d. ", i), 1000)
	}
	c := AIConfig{Primary: "codex", Models: map[string]string{"codex": "chat-model"}, TranslationModels: map[string]string{"codex": "selected-codex"}, TranslationEfforts: map[string]map[string]string{"codex": {"selected-codex": "high"}}, Capabilities: map[string]Capability{}}
	c.Capabilities["codex"] = Capability{Text: true, Fingerprint: configPrint(c, "codex")}
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	return s, p, m, capture
}
func TestTranslationCodexWorkersReuseSelectedModelAndEffort(t *testing.T) {
	s, p, m, capture := translationSessionFixture(t)
	for i := 2; i < 6; i++ {
		b := m.Blocks[0]
		b.ID = fmt.Sprintf("p1-b%d", i+1)
		b.Text = strings.Repeat(fmt.Sprintf("Paragraph %d. ", i), 1000)
		m.Blocks = append(m.Blocks, b)
	}
	if err := s.settleTranslations(t.Context(), &p, m); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	type counts struct{ starts, initializes, turns int }
	processes := map[int]*counts{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var r struct {
			PID    int    `json:"pid"`
			Method string `json:"method"`
			Params struct {
				Model    string `json:"model"`
				Effort   string `json:"effort"`
				ThreadID string `json:"threadId"`
			} `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatal(err)
		}
		if processes[r.PID] == nil {
			processes[r.PID] = &counts{}
		}
		count := processes[r.PID]
		switch r.Method {
		case "initialize":
			count.initializes++
		case "thread/start":
			count.starts++
			if r.Params.Model != "selected-codex" {
				t.Fatal("wrong model")
			}
		case "turn/start":
			count.turns++
			if r.Params.Effort != "high" || r.Params.ThreadID != "thread" {
				t.Fatal("wrong effort or thread")
			}
		}
	}
	if len(processes) != 3 {
		t.Fatalf("expected three worker processes: %+v", processes)
	}
	turns := 0
	for pid, count := range processes {
		turns += count.turns
		if count.initializes != 1 || count.starts != 1 || count.turns < 1 {
			t.Fatalf("pid=%d counts=%+v", pid, count)
		}
	}
	if turns != 6 {
		t.Fatalf("expected six turns across three reused threads, got %d", turns)
	}
	items, err := s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Status != "complete" {
			t.Fatalf("lost paragraph: %+v", item)
		}
	}
	report, err := s.Store.usageReport("doc")
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Calls) != 6 {
		t.Fatalf("calls=%+v", report.Calls)
	}
	for _, call := range report.Calls {
		if len(call.Models) != 1 || call.Models[0].Model != "selected-codex" || call.Models[0].Tokens == nil || call.Models[0].Tokens.TotalTokens != 30 {
			t.Fatalf("usage double-counted: %+v", call)
		}
	}
	if s.aiConfig().Models["codex"] != "chat-model" {
		t.Fatal("changed chat model")
	}
	entries, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("leaked directory: %v %v", entries, err)
	}
}
func TestTranslationCodexCancellationClosesSession(t *testing.T) {
	s, _, m, _ := translationSessionFixture(t)
	t.Setenv("READER_TRANSLATION_CANCEL", "1")
	_, sessions := s.translationService(s.aiConfig())
	defer sessions.close()
	a := sessions.codex
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	batch := translationBatch{Paragraphs: []translationParagraph{{BlockID: m.Blocks[0].ID, SourceHash: translationHash(m.Blocks[0].Text), Source: m.Blocks[0].Text}}}
	_, err := a.Stream(ctx, GenerateRequest{AIInput{Prompt: translationPrompt(Document{}, m, batch, "")}}, func(e ProviderEvent) error {
		if e.Text != "" {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || a.session != nil || a.work != "" {
		t.Fatalf("cancellation leaked session: %v %+v", err, a)
	}
}

func TestTranslationCodexCancellationClosesAllWorkers(t *testing.T) {
	s, p, m, capture := translationSessionFixture(t)
	b := m.Blocks[0]
	b.ID = "p1-b3"
	m.Blocks = append(m.Blocks, b)
	t.Setenv("READER_TRANSLATION_CANCEL", "1")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.settleTranslations(ctx, &p, m) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		items, err := s.translations("doc", m)
		if err != nil {
			t.Fatal(err)
		}
		complete := 0
		for _, item := range items {
			if item.Status == "complete" {
				complete++
			}
		}
		if complete == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("three workers did not stream paragraphs")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation reported %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("workers did not stop")
	}
	data, err := os.ReadFile(capture)
	if err != nil || strings.Count(string(data), `"method":"thread/start"`) != 3 {
		t.Fatalf("did not create three threads: %s %v", data, err)
	}
	entries, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("worker directories leaked: %v %v", entries, err)
	}
}

func TestTranslationCodexFailureRetryPreservesCompletedParagraphs(t *testing.T) {
	s, p, m, capture := translationSessionFixture(t)
	t.Setenv("READER_TRANSLATION_FAIL_SECOND", "1")
	// Exercise a failed subsequent turn on one worker's reused conversation.
	service, adapter := s.translationService(s.aiConfig())
	defer adapter.close()
	initial, err := s.textTranslations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	batches := translationBatches(m, initial, translationBatchCharacters)
	if err := s.translateBatch(t.Context(), Document{ID: "doc"}, m, batches[0], service, func() {}); err != nil {
		t.Fatal(err)
	}
	if err := s.translateBatch(t.Context(), Document{ID: "doc"}, m, batches[1], service, func() {}); err != nil {
		t.Fatal(err)
	}
	adapter.close()
	items, err := s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	if items[0].Status != "complete" || items[1].Status != "failed" {
		t.Fatalf("lost completed translation: %+v", items)
	}
	if !capable(s.aiConfig(), "codex", false) {
		t.Fatal("translation failure invalidated chat capability")
	}
	t.Setenv("READER_TRANSLATION_FAIL_SECOND", "")
	items[1].Status = "pending"
	items[1].Error = ""
	if err := s.saveTranslation("doc", items[1]); err != nil {
		t.Fatal(err)
	}
	if err := s.settleTranslations(t.Context(), &p, m); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	starts, turns := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var r struct {
			Method string `json:"method"`
			Params struct {
				Input []struct {
					Text string `json:"text"`
				} `json:"input"`
			} `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatal(err)
		}
		if r.Method == "thread/start" {
			starts++
		}
		if r.Method == "turn/start" {
			turns++
			if turns == 3 {
				_, raw, _ := strings.Cut(r.Params.Input[0].Text, "输入资料：\n")
				var input translationTestInput
				if json.Unmarshal([]byte(raw), &input) != nil || len(input.Batch.Paragraphs) != 1 || input.Batch.Paragraphs[0].BlockID != m.Blocks[1].ID {
					t.Fatal("retry regenerated completed paragraph")
				}
			}
		}
	}
	if starts != 2 || turns != 3 {
		t.Fatalf("starts=%d turns=%d", starts, turns)
	}
}
