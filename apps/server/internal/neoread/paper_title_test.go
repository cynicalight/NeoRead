package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"neoread.local/server/internal/scholar"
)

func TestAutoPaperTitleFallback(t *testing.T) {
	s := testServer(t)
	scholarFixture(t, s)
	upstream, calls := fakeAPI(t, func(_ int, _ apiCall) string { return `{"title":"A Reliable Paper Title"}` })
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, TranslationModels: map[string]string{"api": "deepseek-flash"}}
	passModels(&config, map[string]bool{"deepseek-flash": false})
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	node := filepath.Join(temp, "node")
	script := "#!/bin/sh\nprintf '%s' '{\"metadata\":{},\"pages\":[\"A Reliable Paper Title\\nAuthors and abstract\"]}' > \"$5\"\n"
	if err := os.WriteFile(node, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_PROCESSOR", filepath.Join(temp, "main.mjs"))
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	revision := s.connectorRevision.Load()
	got, err := s.autoPaperLookup(context.Background(), d.ID)
	if err != nil || got.Title != "random" || got.Metadata.SuggestedTitle != "A Reliable Paper Title" || got.Metadata.Lookup != "notFound" {
		t.Fatalf("got title %q state %q err %v", got.Title, got.Metadata.Lookup, err)
	}
	if s.connectorRevision.Load() <= revision {
		t.Fatal("title update did not notify library")
	}
	if len(calls()) != 1 || calls()[0].Model != "deepseek-flash" {
		t.Fatalf("unexpected calls: %+v", calls())
	}
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"Manual title"}`))
	got, err = s.autoPaperLookup(context.Background(), d.ID)
	if err != nil || got.Title != "Manual title" || got.Metadata.SuggestedTitle != "A Reliable Paper Title" {
		t.Fatalf("manual title overwritten: %q %v", got.Title, err)
	}
}

func TestAutoPaperTitleSkipsUnconfiguredAI(t *testing.T) {
	s := testServer(t)
	temp := t.TempDir()
	node := filepath.Join(temp, "node")
	script := "#!/bin/sh\nprintf '%s' '{\"metadata\":{},\"pages\":[\"Paper text\"]}' > \"$5\"\n"
	if err := os.WriteFile(node, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_PROCESSOR", filepath.Join(temp, "main.mjs"))
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	got, err := s.autoPaperLookup(context.Background(), d.ID)
	if err != errNoIdentifier || got.Title != "random" {
		t.Fatalf("got %q, %v", got.Title, err)
	}
}

func TestExtractedTitleLooksUpPaperMetadata(t *testing.T) {
	s := testServer(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("query") != "A Reliable Paper Title" {
			t.Errorf("unexpected query %q", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"data":[{"title":"A Reliable Paper Title","venue":"Example Journal","authors":[{"name":"Alex Smith"}]}]}`))
	}))
	defer server.Close()
	client := scholar.New(maxImportBytes)
	client.AllowPrivateHosts = true
	client.SemanticScholar = server.URL + "/"
	s.scholar = client
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	found, err := s.lookupScholarCandidates(context.Background(), d.ID, []scholar.Identifiers{{Title: "A Reliable Paper Title"}}, true)
	if err != nil || found.Venue != "Example Journal" {
		t.Fatalf("metadata lookup: %+v %v", found, err)
	}
}

func TestPaperTitleSuggestionApplyDismissAndEqual(t *testing.T) {
	s := testServer(t)
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	got, err := s.applyFound(d.ID, PaperMetadata{}, "random", "ai", "notFound")
	if err != nil || got.Metadata.SuggestedTitle != "" {
		t.Fatalf("equal title suggested: %+v %v", got, err)
	}
	got, err = s.applyFound(d.ID, PaperMetadata{}, "Suggested Title", "ai", "notFound")
	if err != nil || got.Title != "random" || got.Metadata.SuggestedTitle != "Suggested Title" {
		t.Fatalf("suggestion: %+v %v", got, err)
	}
	w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"suggestedTitle":""}}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ = s.Store.Document(d.ID)
	if got.Title != "random" || got.Metadata.SuggestedTitle != "" {
		t.Fatalf("dismiss: %+v", got)
	}
	_, _ = s.applyFound(d.ID, PaperMetadata{}, "Suggested Title", "ai", "notFound")
	w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"Suggested Title","metadata":{"suggestedTitle":""}}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ = s.Store.Document(d.ID)
	if got.Title != "Suggested Title" || got.Metadata.SuggestedTitle != "" || got.Metadata.Sources["title"] != "manual" {
		t.Fatalf("apply: %+v", got)
	}
}
