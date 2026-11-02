package neoread

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type adapterFunc func(context.Context, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error)

func (f adapterFunc) Stream(c context.Context, r GenerateRequest, e func(ProviderEvent) error) (GenerateResult, error) {
	return f(c, r, e)
}
func TestGenerationAttemptBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name      string
		returned  string
		reason    string
		wantError bool
	}{
		{"match", "a", "stop", false}, {"rewrite", "b", "stop", true}, {"no-terminal", "a", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var late func(ProviderEvent) error
			var text string
			a := adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
				late = emit
				_ = emit(ProviderEvent{Text: "a"})
				return GenerateResult{Text: tc.returned, FinishReason: tc.reason}, nil
			})
			_, err := runAttempt(t.Context(), a, AIInput{}, func(e ProviderEvent) error { text += e.Text; return nil })
			if (err != nil) != tc.wantError {
				t.Fatal(err)
			}
			if late(ProviderEvent{Text: "late"}) == nil || text != "a" {
				t.Fatal("late event escaped")
			}
		})
	}
	t.Run("consumer-error", func(t *testing.T) {
		failure := errors.New("write failed")
		calls := 0
		a := adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			_ = emit(ProviderEvent{Text: "a"})
			_ = emit(ProviderEvent{Text: "late"})
			if ctx.Err() == nil {
				t.Error("not canceled")
			}
			return GenerateResult{Text: "alate", FinishReason: "stop"}, nil
		})
		_, err := runAttempt(t.Context(), a, AIInput{}, func(e ProviderEvent) error { calls++; return failure })
		if !errors.Is(err, failure) || calls != 1 {
			t.Fatal(calls, err)
		}
	})
}
func TestGenerationFallbackPolicy(t *testing.T) {
	for _, mode := range []string{"before", "after", "draft", "reasoning", "background", "cancel", "timeout", "emit-failure", "busy"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if mode == "timeout" {
				var stop context.CancelFunc
				ctx, stop = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer stop()
			}
			backups := 0
			var visible string
			primary := adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
				if mode == "busy" {
					return GenerateResult{}, generationError(ErrorBusy, "会话仍由 Codex App 占用")
				}
				if mode == "draft" {
					_ = emit(ProviderEvent{Draft: "partial"})
				} else if mode == "reasoning" {
					_ = emit(ProviderEvent{Reasoning: "thinking"})
				} else if mode != "before" {
					_ = emit(ProviderEvent{Text: "partial"})
				}
				if mode == "cancel" {
					cancel()
				}
				return GenerateResult{}, errors.New("upstream failed")
			})
			backup := adapterFunc(func(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
				backups++
				if err := emit(ProviderEvent{Text: "backup"}); err != nil {
					return GenerateResult{}, err
				}
				return GenerateResult{Text: "backup", FinishReason: "stop"}, nil
			})
			g := &GenerationService{primary: "codex", connections: map[string]generationConnection{"codex": {Adapter: primary, VerifiedText: true}, "text-api": {Adapter: backup, VerifiedText: true}}}
			result, err := g.generate(ctx, AIInput{}, false, mode != "background", func(e ProviderEvent) error {
				if mode == "emit-failure" {
					return errors.New("disconnected")
				}
				if mode != "background" {
					visible += e.Text
				}
				return nil
			})
			want := mode == "before" || mode == "background"
			if want {
				if err != nil || backups != 1 || result.Text != "backup" {
					t.Fatal(result, backups, err)
				}
			} else if err == nil || backups != 0 {
				t.Fatal(result, backups, err)
			}
			if mode == "busy" && errorKind(err) != ErrorBusy {
				t.Fatal("thread ownership error was replaced", err)
			}
			if strings.Contains(visible, "partialbackup") {
				t.Fatal("mixed attempts")
			}
		})
	}
}
func TestAgentCancellationHandshake(t *testing.T) {
	for _, p := range []string{"codex", "kimi"} {
		for _, mode := range []string{"protocol-cancel", "ignore-cancel"} {
			t.Run(p+"/"+mode, func(t *testing.T) {
				ack := fakeAgent(t, p, mode)
				s := testServer(t)
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				text := ""
				start := time.Now()
				_, err := invokeCLI(ctx, s.Store.Root, p, "", AIInput{Prompt: "test"}, func(part string) { text += part; cancel() })
				if !errors.Is(err, context.Canceled) || text != "你好" {
					t.Fatalf("text=%q err=%v", text, err)
				}
				if _, err := os.Stat(ack); err != nil {
					t.Fatal("missing protocol cancel", err)
				}
				if time.Since(start) > 2*time.Second {
					t.Fatal("cancel exceeded grace period")
				}
				entries, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
				if err != nil || len(entries) != 0 {
					t.Fatal("work directory leak", err)
				}
			})
		}
	}
}
func TestAgentTerminalAndIdentity(t *testing.T) {
	for _, tc := range []struct {
		p, mode string
		ok      bool
	}{{"claude", "late", true}, {"claude", "exit-error", false}, {"kimi", "identity", true}, {"kimi", "version", false}} {
		t.Run(tc.p+"/"+tc.mode, func(t *testing.T) {
			fakeAgent(t, tc.p, tc.mode)
			s := testServer(t)
			var text string
			result, err := invokeCLI(t.Context(), s.Store.Root, tc.p, "", AIInput{Prompt: "test"}, func(p string) { text += p })
			if tc.ok {
				if err != nil || text != "你好，世界" || result != text {
					t.Fatal(result, text, err)
				}
			} else if err == nil {
				t.Fatal("expected failure")
			}
		})
	}
}

func TestChatSaveFailureAndWriteFailure(t *testing.T) {
	for _, mode := range []string{"save", "write", "flush"} {
		t.Run(mode, func(t *testing.T) {
			fakeAgent(t, "claude", "success")
			s, _ := imageFixture(t)
			if mode == "save" {
				// SQLite trigger fails only assistant insertion; user record stays intact.
				_, err := s.Store.DB.Exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON messages WHEN json_extract(NEW.body,'$.role')='assistant' BEGIN SELECT RAISE(FAIL,'test'); END`)
				if err != nil {
					t.Fatal(err)
				}
				res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"claude","prompt":"test","context":""}`))
				if strings.Count(res.Body.String(), "event: error") != 1 || strings.Contains(res.Body.String(), "event: done") {
					t.Fatal(res.Body.String())
				}
				var count int
				if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 1 {
					t.Fatal(count, err)
				}
			} else {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				recorder := httptest.NewRecorder()
				out := &chatStreamWriter{w: &brokenWriter{ResponseRecorder: recorder, flush: mode == "flush"}, cancel: cancel}
				if out.send("delta", map[string]string{"text": "test"}) == nil || ctx.Err() == nil {
					t.Fatal("write failure did not cancel")
				}
				if out.send("done", map[string]bool{"ok": true}) == nil {
					t.Fatal("terminal gate open")
				}
			}
		})
	}
}

type brokenWriter struct {
	*httptest.ResponseRecorder
	flush bool
}

func (w *brokenWriter) Write(b []byte) (int, error) {
	if !w.flush {
		return 0, errors.New("broken pipe")
	}
	return w.ResponseRecorder.Write(b)
}
func (w *brokenWriter) FlushError() error { return errors.New("flush failed") }

var _ http.ResponseWriter = (*brokenWriter)(nil)

func TestHTTPDisconnectCancelsGeneration(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			fakeAgent(t, provider, "cancel")
			s, _ := imageFixture(t)
			c := AIConfig{Primary: provider, Models: map[string]string{}, Capabilities: map[string]Capability{}}
			c.Capabilities[provider] = Capability{Text: true, Fingerprint: configPrint(c, provider)}
			if err := s.writeAIConfig(c); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(s.Handler())
			defer server.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/documents/doc/chat", strings.NewReader(fmt.Sprintf(`{"provider":%q,"prompt":"test","context":""}`, provider)))
			req.Header.Set("Authorization", "Bearer test-secret")
			res, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			scan := bufio.NewScanner(res.Body)
			saw := false
			for scan.Scan() {
				if scan.Text() == "event: delta" {
					saw = true
					break
				}
			}
			_ = res.Body.Close()
			cancel()
			if !saw {
				t.Fatal("no first delta")
			}
			deadline := time.Now().Add(2 * time.Second)
			for !s.aiMu.TryLock() {
				if time.Now().After(deadline) {
					t.Fatal("interactive lock leaked")
				}
				time.Sleep(10 * time.Millisecond)
			}
			s.aiMu.Unlock()
			var count int
			if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 1 {
				t.Fatal("partial answer saved", count, err)
			}
			entries, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
			if err != nil || len(entries) != 0 {
				t.Fatal("work directory leaked", err)
			}
		})
	}
}

type lostDoneWriter struct{ *httptest.ResponseRecorder }

func (w lostDoneWriter) Write(b []byte) (int, error) {
	if strings.HasPrefix(string(b), "event: done") {
		return 0, errors.New("disconnected after save")
	}
	return w.ResponseRecorder.Write(b)
}
func TestDoneLossDoesNotRollbackSavedAnswer(t *testing.T) {
	fakeAgent(t, "claude", "success")
	s, _ := imageFixture(t)
	req := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents/doc/chat", strings.NewReader(`{"provider":"claude","prompt":"test","context":""}`))
	req.Header.Set("Authorization", "Bearer test-secret")
	w := lostDoneWriter{httptest.NewRecorder()}
	s.Handler().ServeHTTP(w, req)
	if strings.Contains(w.Body.String(), "event: done") || strings.Contains(w.Body.String(), "event: error") {
		t.Fatal(w.Body.String())
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 2 {
		t.Fatal("saved answer lost", count, err)
	}
}
func TestChatRequiredFields(t *testing.T) {
	s, _ := imageFixture(t)
	for _, body := range []string{`{"prompt":"test","context":""}`, `{"provider":"codex","prompt":"test"}`, `{"provider":"codex","prompt":"test","context":null}`} {
		res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
		if res.Code != 400 {
			t.Fatal(res.Code, res.Body.String())
		}
	}
}

func TestChatGenerationDeadlineAppliesToAllProviders(t *testing.T) {
	for _, provider := range []string{"api", "codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			adapter := adapterFunc(func(ctx context.Context, _ GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) < 59*time.Minute || time.Until(deadline) > time.Hour {
					t.Errorf("unexpected chat deadline %v", deadline)
				}
				if err := emit(ProviderEvent{Text: "complete"}); err != nil {
					return GenerateResult{}, err
				}
				return GenerateResult{Text: "complete", FinishReason: "stop"}, nil
			})
			service := &GenerationService{primary: provider, connections: map[string]generationConnection{provider: {Adapter: adapter, VerifiedText: true}}}
			_, err := service.generate(context.Background(), AIInput{Chat: &chatInput{}}, false, true, nil)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
