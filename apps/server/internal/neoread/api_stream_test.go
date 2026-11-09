package neoread

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func writeAPIReply(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":%q},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", text)
}

func TestCompletionStreamBoundaries(t *testing.T) {
	part := `data: {"choices":[{"index":0,"delta":{"content":"你 好\n"}}]}` + "\n\n"
	stop := `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n"
	end := "data: [DONE]\n\n"
	for _, tc := range []struct {
		name, wire string
		ok         bool
		kind       ErrorKind
	}{
		{"normal", part + stop + end, true, ""},
		{"crlf-comments-multiline", ": heartbeat\r\nevent: message\r\ndata: {\"choices\":\r\ndata: [{\"index\":0,\"delta\":{\"content\":\"你 好\\n\"}}]}\r\n\r\n" + stop + end, true, ""},
		{"other-choice", `data: {"choices":[{"index":1,"delta":{"content":"private"}},{"index":0,"delta":{"content":"你 好\n"}}]}` + "\n\n" + stop + end, true, ""},
		{"no-terminal", part, false, ErrorProtocol},
		{"no-done", part + stop, false, ErrorProtocol},
		{"no-reason", part + end, false, ErrorProtocol},
		{"empty", stop + end, false, ErrorProtocol},
		{"malformed", part + "data: {\n\n", false, ErrorProtocol},
		{"upstream-error", part + `data: {"error":{"message":"SECRET_KEY"}}` + "\n\n", false, ErrorUpstream},
		{"length", part + `data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}` + "\n\n" + end, false, ErrorLimit},
		{"refusal", `data: {"choices":[{"index":0,"delta":{"refusal":"no"}}]}` + "\n\n", false, ErrorUpstream},
		{"late", part + stop + part + end, false, ErrorProtocol},
		{"missing-index", `data: {"choices":[{"delta":{"content":"oops"}}]}` + "\n\n", false, ErrorProtocol},
		{"tool", `data: {"choices":[{"index":0,"delta":{"tool_calls":[{}]}}]}` + "\n\n", false, ErrorCapability},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var text string
			// One byte reads split UTF-8 and every SSE delimiter independently.
			result, err := readCompletionStream(t.Context(), oneByteReader{strings.NewReader(tc.wire)}, func(e ProviderEvent) error { text += e.Text; return nil })
			if tc.ok {
				if err != nil || result.Text != "你 好\n" || result.Text != text {
					t.Fatalf("%+v %q %v", result, text, err)
				}
			} else if err == nil || errorKind(err) != tc.kind || strings.Contains(err.Error(), "SECRET_KEY") {
				t.Fatalf("%v", err)
			}
		})
	}
	t.Run("escaped-frame", func(t *testing.T) {
		// Legal answer below 1 MiB with a wire representation above the old 2 MiB cap.
		wire := `data: {"choices":[{"index":0,"delta":{"content":"` + strings.Repeat(`\u0061`, 500000) + `"}}]}` + "\n\n" + stop + end
		result, err := readCompletionStream(t.Context(), strings.NewReader(wire), nil)
		if err != nil || len(result.Text) != 500000 {
			t.Fatalf("length=%d %v", len(result.Text), err)
		}
	})
	t.Run("large-answer-and-reasoning", func(t *testing.T) {
		answer := strings.Repeat("a", (1<<20)+1)
		reasoning := strings.Repeat("r", (1<<20)+1)
		wire := "data: " + jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": answer, "reasoning_content": reasoning}}}}) + "\n\n" + stop + end
		var observed strings.Builder
		result, err := readCompletionStream(t.Context(), strings.NewReader(wire), func(e ProviderEvent) error { observed.WriteString(e.Reasoning); return nil })
		if err != nil || result.Text != answer || observed.String() != reasoning {
			t.Fatalf("large result lost: text=%d reasoning=%d %v", len(result.Text), observed.Len(), err)
		}
	})
	t.Run("large-frame", func(t *testing.T) {
		answer := strings.Repeat("a", (8<<20)+1)
		wire := "data: " + jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": answer}}}}) + "\n\n" + stop + end
		result, err := readCompletionStream(t.Context(), strings.NewReader(wire), nil)
		if err != nil || result.Text != answer {
			t.Fatalf("large frame lost: text=%d %v", len(result.Text), err)
		}
	})

}

type oneByteReader struct{ io.Reader }

func (r oneByteReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:1]) }

func TestAPIHTTPBoundaries(t *testing.T) {
	for _, code := range []int{401, 429, 500} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code); fmt.Fprint(w, "SECRET_KEY") }))
			defer upstream.Close()
			_, err := invokeAPI(t.Context(), APIConnection{URL: upstream.URL, Model: "test", Key: "SECRET_KEY"}, AIInput{Prompt: "test"}, nil)
			if err == nil || strings.Contains(err.Error(), "SECRET_KEY") {
				t.Fatal(err)
			}
		})
	}
	t.Run("redirect", func(t *testing.T) {
		var targetCalls atomic.Int32
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
		defer target.Close()
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
		defer upstream.Close()
		_, err := invokeAPI(t.Context(), APIConnection{URL: upstream.URL, Model: "test", Key: "secret"}, AIInput{Prompt: "test"}, nil)
		if err == nil || targetCalls.Load() != 0 {
			t.Fatal("redirect followed", err)
		}
	})
	t.Run("no-stream-retry", func(t *testing.T) {
		var calls atomic.Int32
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			fmt.Fprint(w, `{"choices":[{"message":{"content":"answer"}}]}`)
		}))
		defer upstream.Close()
		_, err := invokeAPI(t.Context(), APIConnection{URL: upstream.URL, Model: "test"}, AIInput{Prompt: "test"}, nil)
		if err == nil || calls.Load() != 1 {
			t.Fatal("unexpected non-stream acceptance/retry", err)
		}
	})
	t.Run("emit-failure-cancels-http", func(t *testing.T) {
		stopped := make(chan struct{})
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"}}]}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(stopped)
		}))
		defer upstream.Close()
		failure := errors.New("consumer closed")
		_, err := (apiAdapter{APIConnection{URL: upstream.URL, Model: "test"}}).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "test"}}, func(ProviderEvent) error { return failure })
		if !errors.Is(err, failure) {
			t.Fatal(err)
		}
		select {
		case <-stopped:
		case <-time.After(time.Second):
			t.Fatal("HTTP body not closed")
		}
	})
}

func TestAPIFallbackStreamsOverHTTP(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		for _, vision := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/image=%t", provider, vision), func(t *testing.T) {
				fakeAgent(t, provider, "fail-before")
				gate := make(chan struct{})
				var released sync.Once
				defer released.Do(func() { close(gate) })
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var body struct {
						Stream   bool `json:"stream"`
						N        int  `json:"n"`
						Messages []struct {
							Content json.RawMessage `json:"content"`
						} `json:"messages"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil || !body.Stream || body.N != 1 || len(body.Messages) != 2 {
						t.Error("not a streaming request")
						return
					}
					if vision && !strings.Contains(string(body.Messages[1].Content), "data:image/png;base64,") {
						t.Error("missing image")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"首段\"}}]}\n\n")
					w.(http.Flusher).Flush()
					select {
					case <-gate:
					case <-r.Context().Done():
						return
					case <-time.After(3 * time.Second):
						t.Error("client did not receive first delta")
						return
					}
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"尾段\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
				}))
				defer upstream.Close()
				s, _ := imageFixture(t)
				config := AIConfig{Primary: provider, Models: map[string]string{}, TextAPI: APIConnection{URL: upstream.URL, Model: "test"}, ImageAPI: APIConnection{URL: upstream.URL, Model: "test"}, Capabilities: map[string]Capability{}}
				for _, p := range []string{provider, "text-api", "image-api"} {
					config.Capabilities[p] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, p)}
				}
				if err := s.writeAIConfig(config); err != nil {
					t.Fatal(err)
				}
				server := httptest.NewServer(s.Handler())
				defer server.Close()
				body := map[string]any{"provider": provider, "prompt": "test", "context": ""}
				if vision {
					body["attachments"] = []string{"p1-b1"}
				}
				raw, _ := json.Marshal(body)
				ctx, cancel := context.WithTimeout(t.Context(), 6*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/documents/doc/chat", bytes.NewReader(raw))
				req.Header.Set("Authorization", "Bearer test-secret")
				res, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				scan := bufio.NewScanner(res.Body)
				event, text := "", ""
				fallback, done := 0, 0
				for scan.Scan() {
					line := scan.Text()
					if strings.HasPrefix(line, "event: ") {
						event = strings.TrimPrefix(line, "event: ")
					}
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					switch event {
					case "error":
						t.Fatal(line)
					case "fallback":
						fallback++
					case "done":
						done++
					case "delta":
						if fallback != 1 {
							t.Fatal("delta before fallback")
						}
						var e struct {
							Text string `json:"text"`
						}
						if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &e) != nil {
							t.Fatal(line)
						}
						text += e.Text
						if text == "首段" {
							var count int
							if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 1 {
								t.Fatal("premature save", count, err)
							}
							released.Do(func() { close(gate) })
						}
					}
				}
				if scan.Err() != nil || done != 1 || text != "首段尾段" {
					t.Fatalf("done=%d text=%q err=%v", done, text, scan.Err())
				}
				var count int
				if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages").Scan(&count); err != nil || count != 2 {
					t.Fatal(count, err)
				}
			})
		}
	}
}
