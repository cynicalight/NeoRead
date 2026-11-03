package neoread

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestFormulaTimeoutRetryIsBoundedAndCancelable(t *testing.T) {
	for _, mode := range []string{"recover", "exhaust", "upstream", "invalid-math", "cancel-backoff", "parent-deadline", "already-canceled"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if mode == "already-canceled" {
					cancel()
				}
				if mode == "parent-deadline" {
					var stop context.CancelFunc
					ctx, stop = context.WithTimeout(ctx, time.Minute)
					defer stop()
				}
				var cancelTimer *time.Timer
				defer func() {
					if cancelTimer != nil {
						cancelTimer.Stop()
					}
				}()
				calls := 0
				service := &GenerationService{
					primary: "codex",
					connections: map[string]generationConnection{
						"codex": {
							VerifiedText: true, VerifiedVision: true,
							Adapter: adapterFunc(func(call context.Context, _ GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
								calls++
								switch mode {
								case "upstream":
									return GenerateResult{}, generationError(ErrorUpstream, "temporary upstream error")
								case "invalid-math":
									_ = emit(ProviderEvent{Text: "not a formula"})
									return GenerateResult{Text: "not a formula", FinishReason: "stop"}, nil
								case "cancel-backoff":
									cancelTimer = time.AfterFunc(500*time.Millisecond, cancel)
									return GenerateResult{}, context.DeadlineExceeded
								}
								if calls == 1 || mode == "exhaust" {
									_ = emit(ProviderEvent{Text: "$$unfinished"})
									<-call.Done()
									return GenerateResult{}, call.Err()
								}
								_ = emit(ProviderEvent{Text: "$$x=1$$"})
								return GenerateResult{Text: "$$x=1$$", FinishReason: "stop"}, nil
							}),
						},
					},
				}
				start := time.Now()
				text, err := generateFormula(ctx, service, AIInput{Image: []byte{1}})
				switch mode {
				case "recover":
					if err != nil || calls != 2 || text != "$$x=1$$\n" {
						t.Fatalf("calls=%d text=%q err=%v", calls, text, err)
					}
				case "exhaust":
					if errorKind(err) != ErrorTimeout || calls != 2 || text != "" || !strings.Contains(err.Error(), "重试") {
						t.Fatalf("calls=%d text=%q err=%v", calls, text, err)
					}
					if elapsed := time.Since(start); elapsed != 6*time.Minute+time.Second {
						t.Fatalf("unexpected retry budget: %v", elapsed)
					}
				case "cancel-backoff", "already-canceled":
					wantCalls := 1
					if mode == "already-canceled" {
						wantCalls = 0
					}
					if !errors.Is(err, context.Canceled) || calls != wantCalls || text != "" {
						t.Fatalf("calls=%d text=%q err=%v", calls, text, err)
					}
				default:
					if err == nil || calls != 1 || text != "" {
						t.Fatalf("non-timeout retried: calls=%d text=%q err=%v", calls, text, err)
					}
				}
			})
		})
	}
}

func TestFormulaTimeoutRetrySavesOnlyCompletedResult(t *testing.T) {
	s, _, manifest := formulaFixture(t)
	var calls atomic.Int32
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "gateway timeout", http.StatusGatewayTimeout)
			return
		}
		items, err := s.translations("doc", manifest)
		if err != nil || items[0].Status != "running" || items[0].FormulaMarkdown != "" {
			t.Errorf("retry exposed a failed or partial result: %+v %v", items, err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		sendTranslationDelta(w, "$$x=1$$")
		finishTranslationStream(w)
	}))
	defer images.Close()
	configureFormulaTest(t, s, images.URL, images.URL)
	if err := s.convertFormulas(t.Context(), "doc", manifest); err != nil {
		t.Fatal(err)
	}
	items, err := s.translations("doc", manifest)
	if err != nil || calls.Load() != 2 || items[0].Status != "complete" || items[0].FormulaMarkdown != "$$x=1$$\n" || items[1].Status != "pending" {
		t.Fatalf("calls=%d items=%+v err=%v", calls.Load(), items, err)
	}
	if !capable(s.aiConfig(), "image-api", true) {
		t.Fatal("formula timeout revoked verified image capability")
	}
}
