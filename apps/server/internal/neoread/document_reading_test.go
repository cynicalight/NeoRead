package neoread

import (
	"context"
	"encoding/json"
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

// A local fake app-server exercises the real authenticated MCP transport and
// native cancellation path, without requiring a CLI login or a model call.
func writeReadingCalls(w http.ResponseWriter, count int, block, reasoning string) {
	w.Header().Set("Content-Type", "text/event-stream")
	calls := []any{}
	for i := 0; i < count; i++ {
		name, args := "search_document", jsonText(map[string]string{"query": id()})
		if i == 0 && block != "" {
			name, args = "read_passage", jsonText(map[string]string{"blockId": block})
		}
		calls = append(calls, map[string]any{"index": i, "id": id(), "type": "function", "function": map[string]string{"name": name, "arguments": args}})
	}
	data := jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": calls, "reasoning_content": reasoning}, "finish_reason": "tool_calls"}}})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
}

func TestDocumentReadingBudgetSavesBoundedAnswer(t *testing.T) {
	for _, mode := range []string{"rounds", "calls", "final-failure"} {
		t.Run(mode, func(t *testing.T) {
			s, a := originalDocumentFixture(t)
			readingCalls, finalCalls := 0, 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
					return
				}
				var payload struct {
					Tools []any `json:"tools"`
				}
				if json.NewDecoder(r.Body).Decode(&payload) != nil {
					t.Error("invalid model request")
					return
				}
				threshold := documentReadingRounds + 1
				if mode == "calls" {
					threshold = documentToolCalls/4 + 1
				}
				if readingCalls >= threshold {
					finalCalls++
					if mode == "final-failure" {
						w.WriteHeader(503)
						return
					}
					writeAPIReply(w, "The nonce is COBALT-19 [S2].")
					return
				}
				readingCalls++
				if mode == "time" && readingCalls == 2 {
					<-r.Context().Done()
					return
				}
				count, block, reasoning := 1, "", ""
				if readingCalls == 1 {
					block = a.corpus.Passages[1].ID
				}
				if mode == "calls" {
					count = 4
				}
				if mode == "context" {
					reasoning = strings.Repeat("r", 230<<10)
				}
				writeReadingCalls(w, count, block, reasoning)
			}))
			defer upstream.Close()
			configureDocumentAPI(t, s, upstream.URL)
			ctx := t.Context()
			if mode == "time" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 500*time.Millisecond)
				defer cancel()
			}
			r := httptest.NewRequest("POST", "http://127.0.0.1/api/documents/doc/chat", strings.NewReader(`{"provider":"api","prompt":"Read the nonce","context":""}`)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer test-secret")
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if finalCalls != 1 {
				t.Fatalf("final calls=%d", finalCalls)
			}
			var answers int
			s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE json_extract(body,'$.role')='assistant'").Scan(&answers)
			if mode == "final-failure" {
				if answers != 0 || strings.Contains(w.Body.String(), "event: done") || strings.Contains(w.Body.String(), "阅读范围") {
					t.Fatal("failed final generation saved or emitted a bounded answer")
				}
				return
			}
			if answers != 1 || strings.Count(w.Body.String(), "event: done") != 1 || strings.Contains(w.Body.String(), "event: fallback") {
				t.Fatalf("budget did not finish with evidence: %s", w.Body.String())
			}
			var saved, run string
			s.Store.DB.QueryRow("SELECT json_extract(body,'$.content') FROM messages WHERE json_extract(body,'$.role')='assistant'").Scan(&saved)
			s.Store.DB.QueryRow("SELECT body FROM chat_agent_runs WHERE json_extract(body,'$.status')='complete'").Scan(&run)
			if !strings.Contains(saved, "COBALT-19") || !strings.Contains(run, "stopReason") {
				t.Fatal("bounded answer or reading provenance not persisted")
			}
			switch mode {
			case "rounds":
				if readingCalls != documentReadingRounds+1 {
					t.Fatal(readingCalls)
				}
			case "calls":
				if readingCalls != documentToolCalls/4+1 {
					t.Fatal(readingCalls)
				}
			case "context":
				if readingCalls != 1 {
					t.Fatal(readingCalls)
				}
			case "time":
				if ctx.Err() != nil || readingCalls != 2 {
					t.Fatal("reading consumed final reserve", ctx.Err(), readingCalls)
				}
			}
		})
	}
}

func TestDocumentReadingSoftStopPreservesFailuresAndEvidence(t *testing.T) {
	_, a := originalDocumentFixture(t)
	if _, err := a.call(t.Context(), "read_passage", json.RawMessage(jsonText(map[string]string{"blockId": a.corpus.Passages[1].ID}))); err != nil {
		t.Fatal(err)
	}
	reading, stop := context.WithCancel(t.Context())
	stop()
	if _, err := a.call(reading, "get_outline", json.RawMessage(`{}`)); !errors.Is(err, context.Canceled) || a.fatal != nil {
		t.Fatal("ending only the reading phase poisoned the full request", err)
	}
	a.calls = documentToolCalls - 3
	raw, err := a.call(t.Context(), "get_outline", json.RawMessage(`{}`))
	if err != nil || !strings.Contains(string(raw), `"shouldFinish":true`) || !strings.Contains(string(raw), `"recommendedRemainingCalls":2`) {
		t.Fatal("missing advance budget feedback", err, string(raw))
	}
	a.bytes = (2 << 20) - 1
	if _, err = a.call(t.Context(), "read_passage", json.RawMessage(jsonText(map[string]string{"blockId": a.corpus.Passages[2].ID}))); err != nil || a.fatal != nil || len(a.Evidence) != 2 || a.readingStopped() {
		t.Fatal("former evidence budget blocked source", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err = a.check(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("user cancellation was masked", err)
	}

}

func TestPartialCorpusDisclosesGapsWithoutBudgetStop(t *testing.T) {
	s, a := prepareConversationFixture(t)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		calls++
		if calls == 1 {
			writeReadingCalls(w, 1, a.corpus.Passages[1].ID, "")
		} else {
			writeConversationReply(w, "依据原文回答 [S2]", "")
		}
	}))
	defer upstream.Close()
	configureDocumentAPI(t, s, upstream.URL)
	if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "b.xhtml"), []byte("<html><body></body></html>"), 0600); err != nil {
		t.Fatal(err)
	}
	var err error
	a.corpus, err = s.documentCorpus(t.Context(), "doc", nil)
	if err != nil || a.corpus.Coverage.Status != "partial" {
		t.Fatal("fixture did not lose a chapter", err)
	}

	r := conversationRequest(t, s, "api", "请核对原文")
	if strings.Count(r.Body.String(), "event: done") != 1 {
		t.Fatal(r.Body)
	}
	if !strings.Contains(r.Body.String(), "无法检索的原文范围") || strings.Contains(r.Body.String(), "因结束阅读") {
		t.Fatal("gap notice missing or malformed", r.Body)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 2 || !strings.Contains(history[1].Content, "无法检索的原文范围") {
		t.Fatal("notice not saved", err, history)
	}
}
