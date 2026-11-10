package neoread

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebSourcesKeepFullCurrentAndHistoricalContent(t *testing.T) {
	c := &chatInput{}
	text := strings.Repeat("body", 4096)
	for i := 0; i < 48; i++ {
		got := c.addWebSource(WebSource{URL: fmt.Sprintf("https://example.org/%d", i), Title: "Page", Text: text, Kind: "page"})
		if got.ID == "" || got.Text != text || got.Truncated {
			t.Fatalf("current source %d lost content: %+v", i, got)
		}
	}
	snapshot := c.webSourcesSnapshot()
	total := 0
	for _, s := range snapshot {
		total += len(s.Text)
	}
	if len(snapshot) != 48 || total != 48*len(text) || snapshot[0].Text != text || snapshot[0].Truncated || snapshot[len(snapshot)-1].Text != text {
		t.Fatalf("retention count=%d textbytes=%d", len(snapshot), total)
	}
}

func TestWebSourceSearchResultIsFreshWithoutDowngradingPageArchive(t *testing.T) {
	c := &chatInput{}
	page := c.addWebSource(WebSource{URL: "https://example.org/page", Title: "Page", Text: "read body", Kind: "page"})
	result := c.addWebSource(WebSource{URL: page.URL, Title: "new title", Text: "fresh summary", Kind: "search"})
	if result.ID != page.ID || result.Kind != "search" || result.Text != "fresh summary" {
		t.Fatalf("current result stale: %+v", result)
	}
	snapshot := c.webSourcesSnapshot()
	if len(snapshot) != 1 || snapshot[0].Kind != "page" || snapshot[0].Text != "read body" {
		t.Fatalf("archive downgraded: %+v", snapshot)
	}
}

func TestWebSourcesKeepMetadataBeyondOldSnapshotBudget(t *testing.T) {
	c := &chatInput{}
	first := c.addWebSource(WebSource{URL: "https://example.org/first", Text: "first", Kind: "search"})
	for i := 0; i < 180; i++ {
		got := c.addWebSource(WebSource{URL: fmt.Sprintf("https://example.org/%d/", i) + strings.Repeat("x", 7900), Title: "Page", Text: "body", Kind: "page"})
		if got.ID == "" || got.Text != "body" {
			t.Fatalf("current result suppressed at %d", i)
		}
	}
	raw, _ := json.Marshal(c.webSourcesSnapshot())
	if len(raw) <= 1<<20 || len(c.webSourcesSnapshot()) != 181 {
		t.Fatalf("source metadata dropped: bytes=%d count=%d", len(raw), len(c.webSourcesSnapshot()))
	}
	next := c.addWebSource(WebSource{URL: first.URL, Text: "refreshed", Kind: "page"})
	if first.ID != next.ID || next.Text != "refreshed" {
		t.Fatalf("refresh changed source identity: first=%s next=%+v", first.ID, next)
	}
}

func TestPiWebSourcesBeyondFormerLimitContinue(t *testing.T) {
	piTestRuntime(t)
	server, agent := prepareConversationFixture(t)
	models, fetches := 0, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		models++
		if models == 1 {
			writeToolReply(w, "web_fetch", `{"url":"https://1.1.1.1/new"}`)
			return
		}
		if !strings.Contains(string(raw), "fresh page body") || strings.Contains(string(raw), "web_source_budget_exhausted") {
			t.Error("current page not refilled")
		}
		writeAPIReply(w, "Read [Page](https://1.1.1.1/new).")
	}))
	defer upstream.Close()
	chat := &chatInput{server: server, Agent: agent, DocumentID: "doc", Question: "Read", CurrentText: "Original", WebSearch: true, WebAPI: APIConnection{URL: defaultSearchURL, Key: "fixture"}, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
		fetches++
		return webJSON(200, `{"title":"Page","content":"fresh page body"}`), nil
	})}
	for i := 0; i < 1006; i++ {
		chat.addWebSource(WebSource{URL: fmt.Sprintf("https://example.org/old%d", i), Title: "Old", Text: "saved", Kind: "search"})
	}
	result, err := streamPiChat(t.Context(), APIConnection{URL: upstream.URL, Key: "fixture"}, completionRequest{Model: "test", Tools: true, ContextWindow: 32000}, AIInput{Chat: chat}, nil)
	if err != nil || models != 2 || fetches != 1 || len(chat.WebSources) != 1007 || !strings.Contains(result.Text, "https://1.1.1.1/new") {
		t.Fatalf("result=%+v err=%v models=%d fetches=%d sources=%d", result, err, models, fetches, len(chat.WebSources))
	}
}

func TestWebFetchKeepsBodyLargerThanOldTransportAndSourceLimits(t *testing.T) {
	body := strings.Repeat("full page ", 230000)
	chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
		return webJSON(200, jsonText(map[string]string{"title": "Full", "content": body})), nil
	})}
	raw, err := chat.callWebTool(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "web_fetch", json.RawMessage(`{"url":"https://1.1.1.1/full"}`))
	var result struct {
		Source WebSource `json:"source"`
	}
	_ = json.Unmarshal(raw, &result)
	if err != nil || result.Source.Text != body || result.Source.Truncated || len(chat.WebSources) != 1 || chat.WebSources[0].Text != body {
		t.Fatalf("content truncated: err=%v resultbytes=%d archivedsources=%d", err, len(result.Source.Text), len(chat.WebSources))
	}
}

func TestNativeWebReferencesBeyond128RemainResolvable(t *testing.T) {
	chat := &chatInput{WebSearch: true}
	for i := 0; i < 200; i++ {
		chat.rememberNativeWebSource(fmt.Sprintf("turn%dsearch0", i), fmt.Sprintf("https://example.org/%d", i))
	}
	for _, i := range []int{0, 128, 199} {
		got := chat.normalizeWebCitations(fmt.Sprintf("citeturn%dsearch0", i))
		if !strings.Contains(got, fmt.Sprintf("https://example.org/%d", i)) {
			t.Fatalf("mapping %d was discarded: %s", i, got)
		}
	}
}

func TestWebSourceHistoryPersistsFullText(t *testing.T) {
	s, agent := originalDocumentFixture(t)
	chat := &chatInput{}
	text := strings.Repeat("history", 3000)
	for i := 0; i < 48; i++ {
		chat.addWebSource(WebSource{URL: fmt.Sprintf("https://example.org/%d", i), Title: "History", Text: text, Kind: "page"})
	}
	agent.chat = chat
	if err := s.saveDocumentAgentAnswer(t.Context(), agent, "Answer", "codex"); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil || len(history) != 1 || len(history[0].WebSources) != 48 {
		t.Fatalf("history count=%d err=%v", len(history), err)
	}
	for _, source := range history[0].WebSources {
		if source.Text != text || source.Truncated {
			t.Fatalf("stored text truncated: bytes=%d", len(source.Text))
		}
	}
}

func TestWebSearchPreservesAllReturnedResults(t *testing.T) {
	results := []map[string]string{}
	for i := 0; i < 7; i++ {
		results = append(results, map[string]string{"url": fmt.Sprintf("https://example.org/%d", i), "summary": strings.Repeat("summary", 2000)})
	}
	chat := &chatInput{WebSearch: true, webTransport: webRoundTrip(func(*http.Request) (*http.Response, error) {
		return webJSON(200, jsonText(map[string]any{"results": results})), nil
	})}
	raw, err := chat.callWebTool(t.Context(), APIConnection{URL: defaultSearchURL, Key: "test"}, "web_search", json.RawMessage(`{"query":"public"}`))
	var response struct {
		Sources []WebSource `json:"sources"`
	}
	_ = json.Unmarshal(raw, &response)
	if err != nil || len(response.Sources) != 7 || len(chat.WebSources) != 7 || response.Sources[6].Text != results[6]["summary"] {
		t.Fatalf("results dropped: err=%v returned=%d stored=%d", err, len(response.Sources), len(chat.WebSources))
	}
}
