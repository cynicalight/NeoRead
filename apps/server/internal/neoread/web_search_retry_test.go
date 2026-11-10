package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestDeepSeekWebRetriesTransientStatusWithSameBody(t *testing.T) {
	calls := 0
	var body string
	times := []time.Time{}
	chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		times = append(times, time.Now())
		raw, _ := io.ReadAll(r.Body)
		if calls == 1 {
			body = string(raw)
		} else if string(raw) != body {
			t.Error("retry changed payload")
		}
		if calls < 3 {
			return webJSON(503, `{"error":"PRIVATE"}`), nil
		}
		return webJSON(200, `{"results":[{"url":"https://example.org/page","title":"Page","summary":"Body"}]}`), nil
	})}
	raw, err := chat.callWebTool(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "web_search", json.RawMessage(`{"query":"public information"}`))
	if err != nil || calls != 3 || chat.webCalls != 1 || len(chat.WebSources) != 1 || chat.Tools[0].Status != "completed" {
		t.Fatalf("raw=%s err=%v calls=%d toolcalls=%d", raw, err, calls, chat.webCalls)
	}
	if times[1].Sub(times[0]) < time.Second || times[2].Sub(times[1]) < 2*time.Second {
		t.Fatal("retry backoff missing")
	}
}

func TestDeepSeekWebRetryCancellationAndRetryAfter(t *testing.T) {
	t.Run("cancel-backoff", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		calls := 0
		_, err := deepSeekWebRequest(ctx, APIConnection{URL: defaultSearchURL, Key: "test"}, "search", map[string]string{"query": "x"}, webRoundTrip(func(*http.Request) (*http.Response, error) { calls++; cancel(); return webJSON(503, `{}`), nil }))
		if !errors.Is(err, context.Canceled) || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	})
	t.Run("honor-long-retry-after", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		calls := 0
		_, err := deepSeekWebRequest(ctx, APIConnection{URL: defaultSearchURL, Key: "test"}, "search", map[string]string{"query": "x"}, webRoundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			res := webJSON(503, `{}`)
			res.Header.Set("Retry-After", "60")
			return res, nil
		}))
		if err == nil || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	})
}

func TestDeepSeekWebDoesNotRetryTransportReadOrInvalidPayload(t *testing.T) {
	for _, mode := range []string{"transport", "read", "invalid", "auth"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				switch mode {
				case "transport":
					return nil, errors.New("PRIVATE transport")
				case "read":
					res := webJSON(200, "")
					res.Body = io.NopCloser(failingWebRead{})
					return res, nil
				case "auth":
					return webJSON(401, `{"error":"PRIVATE"}`), nil
				default:
					return webJSON(200, `{}`), nil
				}
			})}
			raw, err := chat.callWebTool(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "web_search", json.RawMessage(`{"query":"x"}`))
			if err != nil || calls != 1 || len(chat.WebSources) != 0 || strings.Contains(string(raw), "PRIVATE") {
				t.Fatalf("raw=%s err=%v calls=%d", raw, err, calls)
			}
			if mode == "auth" {
				if chat.Tools[0].Status != "failed" || !strings.Contains(string(raw), "Key 无效") {
					t.Fatalf("auth prompt hidden: %s", raw)
				}
			} else if chat.Tools[0].Status != "deferred" {
				t.Fatalf("not deferred: %v", chat.Tools)
			}
		})
	}
}

type failingWebRead struct{}

func (failingWebRead) Read([]byte) (int, error) { return 0, errors.New("PRIVATE read") }

func TestWebToolInnerTimeoutIsDeferredAndParentCancelPropagates(t *testing.T) {
	for _, parentCancel := range []bool{false, true} {
		ctx, cancel := context.WithCancel(t.Context())
		calls := 0
		chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			if parentCancel {
				cancel()
				return nil, context.Canceled
			}
			return nil, context.DeadlineExceeded
		})}
		raw, err := chat.callWebTool(ctx, APIConnection{URL: defaultSearchURL, Key: "test"}, "web_search", json.RawMessage(`{"query":"x"}`))
		cancel()
		if parentCancel {
			if !errors.Is(err, context.Canceled) || chat.Tools[0].Status != "cancelled" {
				t.Fatalf("err=%v tools=%v", err, chat.Tools)
			}
		} else if err != nil || chat.Tools[0].Status != "deferred" || !strings.Contains(string(raw), "temporarily_unavailable") {
			t.Fatalf("err=%v raw=%s tools=%v", err, raw, chat.Tools)
		}
		if calls != 1 {
			t.Fatalf("timeout retried: %d", calls)
		}
	}
}

func TestDeepSeekWebExhaustedRetriesCountOneToolCall(t *testing.T) {
	calls := 0
	chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		return webJSON(503, `{"error":"PRIVATE 503"}`), nil
	})}
	raw, err := chat.callWebTool(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "web_search", json.RawMessage(`{"query":"x"}`))
	if err != nil || calls != 3 || chat.webCalls != 1 || len(chat.Tools) != 1 || chat.Tools[0].Status != "deferred" || strings.Contains(string(raw), "503") || strings.Contains(chat.Tools[0].Detail, "503") {
		t.Fatalf("err=%v calls=%d toolcalls=%d raw=%s tools=%v", err, calls, chat.webCalls, raw, chat.Tools)
	}
}

func TestDeepSeekWebRetriesExplicitRequestTimeout(t *testing.T) {
	calls := 0
	raw, err := deepSeekWebRequest(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "search", map[string]string{"query": "x"}, webRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return webJSON(408, `{}`), nil
		}
		return webJSON(200, `{"results":[]}`), nil
	}))
	if err != nil || calls != 2 || string(raw) != `{"results":[]}` {
		t.Fatalf("raw=%s err=%v calls=%d", raw, err, calls)
	}
}

func TestDeepSeekWebDoesNotRetryOverflowingRetryAfter(t *testing.T) {
	calls := 0
	_, err := deepSeekWebRequest(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "search", map[string]string{"query": "x"}, webRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		res := webJSON(503, `{}`)
		res.Header.Set("Retry-After", "999999999999999999999999999999999999999999")
		return res, nil
	}))
	if err == nil || calls != 1 {
		t.Fatalf("overflowing Retry-After was shortened: err=%v calls=%d", err, calls)
	}
}

func TestDeepSeekFetchKnown404UsesSharedUnavailableResult(t *testing.T) {
	for _, tc := range []struct {
		name, body  string
		status      int
		unavailable bool
	}{
		{"content", `{"error":{"code":"invalid_request_error","type":"not_found_error","message":"SECRET raw body"}}`, 404, true},
		{"model", `{"error":{"code":"model_not_found","type":"invalid_request_error"}}`, 404, false},
		{"route", `{"detail":"Not Found"}`, 404, false},
		{"wrong-type", `{"error":{"code":"invalid_request_error","type":"other"}}`, 404, false},
		{"invalid-utf8", "{\"error\":{\"code\":\"invalid_request_error\",\"type\":\"not_found_error\",\"message\":\"" + string([]byte{0xff}) + "\"}}", 404, false},
		{"service", `{"error":{"code":"invalid_request_error","type":"not_found_error"}}`, 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) { return webJSON(tc.status, tc.body), nil })}
			raw, err := c.callWebTool(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "web_fetch", json.RawMessage(`{"url":"https://1.1.1.1/missing"}`))
			if err != nil || len(c.WebSources) != 0 {
				t.Fatalf("err=%v sources=%v", err, c.WebSources)
			}
			var result map[string]any
			_ = json.Unmarshal(raw, &result)
			if tc.unavailable {
				if result["status"] != "unavailable" || result["error"] != nil || c.Tools[0].Status != "unavailable" {
					t.Fatalf("result=%s tools=%v", raw, c.Tools)
				}
			} else if result["status"] != "temporarily_unavailable" || result["error"] != nil || c.Tools[0].Status != "deferred" {
				t.Fatalf("failure masked: %s %+v", raw, c.Tools)
			}
			if strings.Contains(string(raw), "SECRET") {
				t.Fatal("raw error leaked")
			}
		})
	}
}

func TestDeepSeekKnown404DoesNotApplyToSearchOrCustomOrigin(t *testing.T) {
	for _, tc := range []struct{ origin, operation string }{
		{defaultSearchURL, "search"},
		{"https://search.example.org", "fetch"},
	} {
		_, err := deepSeekWebRequest(t.Context(), APIConnection{URL: tc.origin, Key: "test"}, tc.operation, map[string]string{}, webRoundTrip(func(*http.Request) (*http.Response, error) {
			return webJSON(404, `{"error":{"code":"invalid_request_error","type":"not_found_error"}}`), nil
		}))
		if err == nil {
			t.Fatalf("unexpected empty-content classification: %s %s", tc.origin, tc.operation)
		}
	}
}

func TestKeenableWebRetriesTransientStatusWithSameRequest(t *testing.T) {
	for _, keyed := range []bool{false, true} {
		conn := APIConnection{Protocol: "keenable", URL: keenableSearchURL}
		want := "POST https://api.keenable.ai/v1/search/public"
		if keyed {
			conn.Key = "keenable-secret"
			want = "POST https://api.keenable.ai/v1/search"
		}
		calls := 0
		times := []time.Time{}
		chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			times = append(times, time.Now())
			raw, _ := io.ReadAll(r.Body)
			if got := r.Method + " " + r.URL.String(); got != want || string(raw) != `{"max_results":5,"query":"public information"}` {
				t.Errorf("retry changed request: %s %s", got, raw)
			}
			if r.Header.Get("X-Keenable-Title") != "NeoRead" || r.Header.Get("X-API-Key") != conn.Key || r.Header.Get("Authorization") != "" {
				t.Errorf("retry changed headers: %v", r.Header)
			}
			switch calls {
			case 1:
				return webJSON(429, `{"error":"PRIVATE"}`), nil
			case 2:
				return webJSON(502, `{"error":"PRIVATE"}`), nil
			}
			return webJSON(200, `{"results":[{"url":"https://example.org/page","title":"Page","snippet":"Body"}]}`), nil
		})}
		raw, err := chat.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"public information"}`))
		if err != nil || calls != 3 || chat.webCalls != 1 || len(chat.WebSources) != 1 || chat.Tools[0].Status != "completed" {
			t.Fatalf("keyed=%v raw=%s err=%v calls=%d", keyed, raw, err, calls)
		}
		if times[1].Sub(times[0]) < time.Second || times[2].Sub(times[1]) < 2*time.Second {
			t.Fatal("retry backoff missing")
		}
	}
}

func TestKeenableWebExhaustedRetriesAreDeferred(t *testing.T) {
	for _, tool := range []string{"web_search", "web_fetch"} {
		calls := 0
		chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			return webJSON(503, `{"error":"PRIVATE 503"}`), nil
		})}
		args := `{"query":"x"}`
		if tool == "web_fetch" {
			args = `{"url":"https://1.1.1.1/page"}`
		}
		raw, err := chat.callWebTool(t.Context(), APIConnection{Protocol: "keenable", URL: keenableSearchURL}, tool, json.RawMessage(args))
		if err != nil || calls != 3 || chat.webCalls != 1 || chat.Tools[0].Status != "deferred" || !strings.Contains(string(raw), "temporarily_unavailable") || strings.Contains(string(raw), "503") {
			t.Fatalf("%s: err=%v calls=%d raw=%s tools=%v", tool, err, calls, raw, chat.Tools)
		}
	}
}

func TestKeenableFetchPageNotFoundUsesSharedUnavailableResult(t *testing.T) {
	for _, tc := range []struct {
		name, tool, body string
		status           int
		unavailable      bool
	}{
		{"page", "web_fetch", `{"error":"Not found","message":"SECRET raw body","type":"target_error","code":"page_not_found"}`, 404, true},
		{"route", "web_fetch", `{"error":"Not found","type":"invalid_request_error","code":"route_not_found"}`, 404, false},
		{"plain", "web_fetch", `Not Found`, 404, false},
		{"search", "web_search", `{"type":"target_error","code":"page_not_found"}`, 404, false},
		{"service", "web_fetch", `{"type":"target_error","code":"page_not_found"}`, 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) { return webJSON(tc.status, tc.body), nil })}
			args := `{"url":"https://1.1.1.1/missing"}`
			if tc.tool == "web_search" {
				args = `{"query":"missing"}`
			}
			raw, err := c.callWebTool(t.Context(), APIConnection{Protocol: "keenable", URL: keenableSearchURL}, tc.tool, json.RawMessage(args))
			if err != nil || len(c.WebSources) != 0 {
				t.Fatalf("err=%v sources=%v", err, c.WebSources)
			}
			var result map[string]any
			_ = json.Unmarshal(raw, &result)
			if tc.unavailable {
				if result["status"] != "unavailable" || result["error"] != nil || c.Tools[0].Status != "unavailable" {
					t.Fatalf("result=%s tools=%v", raw, c.Tools)
				}
			} else if result["status"] != "temporarily_unavailable" || result["error"] != nil || c.Tools[0].Status != "deferred" {
				t.Fatalf("failure masked: %s %+v", raw, c.Tools)
			}
			if strings.Contains(string(raw), "SECRET") {
				t.Fatal("raw error leaked")
			}
		})
	}
}

func TestKeenableWebToolStateSaveFailureIsFatal(t *testing.T) {
	for _, failAt := range []int{1, 2} {
		calls, writes := 0, 0
		chat := &chatInput{WebSearch: true, toolEvent: func(ToolActivity) error {
			writes++
			if writes == failAt {
				return errors.New("storage unavailable")
			}
			return nil
		}, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
			calls++
			return webJSON(200, `{"results":[]}`), nil
		})}
		_, err := chat.callWebTool(t.Context(), APIConnection{Protocol: "keenable", URL: keenableSearchURL}, "web_search", json.RawMessage(`{"query":"x"}`))
		if errorKind(err) != ErrorSave || writes != failAt || calls != failAt-1 {
			t.Fatalf("failAt=%d err=%v writes=%d calls=%d", failAt, err, writes, calls)
		}
	}
}
