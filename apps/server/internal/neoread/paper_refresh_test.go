package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"

	"neoread.local/server/internal/scholar"
	"strings"
	"testing"
)

func TestPaperRefreshEligibility(t *testing.T) {
	base := Document{Library: "papers", Type: "pdf"}
	for _, tc := range []struct {
		name string
		doc  Document
		want bool
	}{
		{"eligible", base, true},
		{"venue present", Document{Library: "papers", Type: "pdf", Metadata: PaperMetadata{Venue: "Journal"}}, true},
		{"manual title", Document{Library: "papers", Type: "pdf", Metadata: PaperMetadata{Sources: map[string]string{"title": "manual"}}}, true},
		{"trashed", Document{Library: "papers", Type: "pdf", DeletedAt: "now"}, false},
		{"book", Document{Library: "books", Type: "pdf"}, false},
		{"epub", Document{Library: "papers", Type: "epub"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := paperRefreshEligible(tc.doc); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestPaperRefreshRechecksAndStopsDuplicates(t *testing.T) {
	s := testServer(t)
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	w = request(t, s, "POST", "/api/diagnostics/paper-refresh", nil)
	if w.Code != http.StatusAccepted {
		t.Fatal(w.Body.String())
	}
	var p paperRefreshProgress
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Total != 1 || p.Status != "running" {
		t.Fatalf("progress %+v err %v", p, err)
	}
	w = request(t, s, "POST", "/api/diagnostics/paper-refresh", nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate status %d", w.Code)
	}
	w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"library":"books"}`))
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	s.runPaperRefresh(context.Background())
	w = request(t, s, "GET", "/api/diagnostics/paper-refresh", nil)
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Status != "done" || p.Processed != 1 || p.Skipped != 1 {
		t.Fatalf("progress %+v err %v", p, err)
	}
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Library != "books" {
		t.Fatalf("document %+v err %v", got, err)
	}
}

func TestPaperRefreshInterruption(t *testing.T) {
	s := testServer(t)
	uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	request(t, s, "POST", "/api/diagnostics/paper-refresh", nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.runPaperRefresh(ctx)
	w := request(t, s, "GET", "/api/diagnostics/paper-refresh", nil)
	var p paperRefreshProgress
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Status != "interrupted" || p.Processed != 0 {
		t.Fatalf("progress %+v err %v", p, err)
	}
}

func TestPaperRefreshManualTitleUsesItForLookup(t *testing.T) {
	s := testServer(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("query") != "A Manual Paper Title" {
			t.Errorf("unexpected lookup query")
		}
		_, _ = w.Write([]byte(`{"data":[{"title":"A Manual Paper Title","venue":"Example Journal"}]}`))
	}))
	defer upstream.Close()
	client := scholar.New(maxImportBytes)
	client.AllowPrivateHosts = true
	client.SemanticScholar = upstream.URL + "/"
	s.scholar = client
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"A Manual Paper Title","metadata":{"venue":"Old edited journal","venueShort":"OLD"}}`))
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	w = request(t, s, "POST", "/api/diagnostics/paper-refresh", nil)
	if w.Code != http.StatusAccepted {
		t.Fatal(w.Body.String())
	}
	s.runPaperRefresh(context.Background())
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Title != "A Manual Paper Title" || got.Metadata.Venue != "Example Journal" || got.Metadata.VenueShort != "" || got.Metadata.Sources["title"] != "lookup" {
		t.Fatalf("document %+v err %v", got, err)
	}
}

func TestPaperRefreshUsesTitleSuggestion(t *testing.T) {
	s := testServer(t)
	scholarFixture(t, s)
	titles := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"title":"A Reliable Paper Title","venue":"Example Journal"}]}`))
	}))
	defer titles.Close()
	s.scholar.SemanticScholar = titles.URL + "/"
	upstream, calls := fakeAPI(t, func(_ int, _ apiCall) string { return `{"title":"A Reliable Paper Title"}` })
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, TranslationModels: map[string]string{"api": "deepseek-flash"}}
	passModels(&config, map[string]bool{"deepseek-flash": false})
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	paperMetadataFixture(t, quickPaperMetadata{Pages: []string{"Paper title and text"}})
	w := uploadTo(t, s, "papers", "random.pdf", testPDF(1))
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	request(t, s, "POST", "/api/diagnostics/paper-refresh", nil)
	s.runPaperRefresh(context.Background())
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Title != "A Reliable Paper Title" || got.Metadata.SuggestedTitle != "" || got.Metadata.Venue != "Example Journal" || got.Metadata.Lookup != "done" || len(calls()) != 1 {
		t.Fatalf("document %+v err %v calls %d", got, err, len(calls()))
	}
}
