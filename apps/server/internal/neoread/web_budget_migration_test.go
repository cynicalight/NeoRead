package neoread

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestWebBudgetMigrationKeepsToolsAvailable(t *testing.T) {
	conn := APIConnection{URL: "https://api.deepseek.com", Key: "key"}
	calls := 0
	c := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		return webJSON(200, `{"results":[{"title":"Doc","url":"https://example.com/doc","summary":"source"}]}`), nil
	})}
	for n := 1; n <= 202; n++ {
		raw, err := c.callWebTool(t.Context(), conn, "web_search", json.RawMessage(`{"query":"docs"}`))
		if err != nil {
			t.Fatalf("call %d interrupted: %v", n, err)
		}
		if n >= 190 && !strings.Contains(string(raw), "budgetNotice") {
			t.Fatalf("call %d missing advisory", n)
		}
	}
	if calls != 202 || len(c.WebSources) != 1 {
		t.Fatalf("calls=%d sources=%d", calls, len(c.WebSources))
	}
	for n := 0; n < 300; n++ {
		if err := c.recordTool(ToolActivity{ID: fmt.Sprint(n), Title: "读取", Status: "completed"}); err != nil {
			t.Fatalf("trace cap stopped answer: %v", err)
		}
	}
	if len(c.Tools) > 256 {
		t.Fatal("unbounded trace storage")
	}
}
func TestCodexWebBudgetMigrationDoesNotAbort(t *testing.T) {
	c := &chatInput{WebSearch: true}
	for n := 0; n < 202; n++ {
		raw := json.RawMessage(fmt.Sprintf(`{"item":{"id":"web-%d","type":"webSearch","query":"docs"}}`, n))
		if err := c.codexToolEvent("item/started", raw); err != nil {
			t.Fatalf("call%d: %v", n, err)
		}
	}
	if c.webCalls != 202 {
		t.Fatal(c.webCalls)
	}
}
func TestWebBudgetMigrationPreservesSourceStorageBudget(t *testing.T) {
	c := &chatInput{WebSearch: true}
	for i := 0; i < webSourceLimit+6; i++ {
		c.addWebSource(WebSource{URL: fmt.Sprintf("https://example.com/%d", i), Kind: "search"})
	}
	if len(c.WebSources) != webSourceLimit {
		t.Fatal("source cap changed", len(c.WebSources))
	}
	raw, err := c.callWebTool(t.Context(), APIConnection{URL: "https://api.deepseek.com", Key: "key"}, "web_search", json.RawMessage(`{"query":"docs"}`))
	if err != nil || !strings.Contains(string(raw), "budgetNotice") || c.Tools[0].Status != "deferred" {
		t.Fatalf("source cap did not return advisory: %s %v", raw, err)
	}
}

func TestWebBudgetMigrationKeepsTraceFailureFatal(t *testing.T) {
	c := &chatInput{WebSearch: true, toolEvent: func(ToolActivity) error { return fmt.Errorf("storage unavailable") }}
	_, err := c.callWebTool(t.Context(), APIConnection{URL: "https://api.deepseek.com", Key: "key"}, "web_search", json.RawMessage(`{"query":"docs"}`))
	if errorKind(err) != ErrorSave {
		t.Fatalf("trace failure was not fatal save error: %v", err)
	}
}

func TestWebBudgetMigrationKeepsCompletedTraceFailureFatal(t *testing.T) {
	writes := 0
	c := &chatInput{WebSearch: true, toolEvent: func(ToolActivity) error {
		writes++
		if writes == 2 {
			return fmt.Errorf("storage unavailable")
		}
		return nil
	}, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) { return webJSON(200, `{"results":[]}`), nil })}
	_, err := c.callWebTool(t.Context(), APIConnection{URL: "https://api.deepseek.com", Key: "key"}, "web_search", json.RawMessage(`{"query":"docs"}`))
	if errorKind(err) != ErrorSave || writes != 2 {
		t.Fatalf("completion trace error swallowed: %v writes=%d", err, writes)
	}
}
