package reader

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"reader.local/server/internal/scholar"
)

const lookupAtom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id>
<published>2017-06-12T00:00:00Z</published><title>Attention Is All You Need</title><summary>Abstract text.</summary>
<author><name>Ashish Vaswani</name></author></entry></feed>`

// scholarFixture serves an arXiv entry and its PDF; it counts requests.
func scholarFixture(t *testing.T, s *Server, pageCounts ...int) *atomic.Int32 {
	t.Helper()
	var hits atomic.Int32
	pages := 3
	if len(pageCounts) > 0 {
		pages = pageCounts[0]
	}
	pdf := testPDF(pages)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch {
		case strings.HasPrefix(r.URL.Path, "/api"):
			w.Write([]byte(lookupAtom))
		case strings.HasPrefix(r.URL.Path, "/pdf/"):
			w.Write(pdf)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	c := scholar.New(maxImportBytes)
	c.AllowPrivateHosts = true
	c.ArXivAPI, c.ArXivPDF = server.URL+"/api", server.URL+"/pdf/"
	c.Crossref, c.SemanticScholar = server.URL+"/none/", server.URL+"/none/"
	s.scholar = c
	return &hits
}
func TestResolveImportsPaperWithMetadata(t *testing.T) {
	s := testServer(t)
	scholarFixture(t, s)
	w := request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"arXiv:1706.03762"}`))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	if d.Library != "papers" || d.Title != "Attention Is All You Need" || d.Author != "Ashish Vaswani" || d.Metadata.ArXiv != "1706.03762" || d.Metadata.Lookup != "done" || d.Metadata.Sources["title"] != "lookup" {
		t.Fatalf("resolved: %+v", d)
	}
	// Resolving again returns the same document without duplicating it.
	if w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"1706.03762"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"x"}`)); w.Code != 400 {
		t.Fatalf("bad reference: %d %s", w.Code, w.Body.String())
	}
}
func TestLookupKeepsManualEdits(t *testing.T) {
	s := testServer(t)
	scholarFixture(t, s)
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(2))
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	if d.Metadata.Lookup != "pending" {
		t.Fatalf("file import not queued for lookup: %+v", d.Metadata)
	}
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"My title","metadata":{"arxiv":"1706.03762","date":"2016"}}`))
	if w = request(t, s, "POST", "/api/documents/"+d.ID+"/metadata/lookup", nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ := s.Store.Document(d.ID)
	if got.Title != "My title" || got.Metadata.Date != "2016" || got.Metadata.Abstract != "Abstract text." || got.Author != "Ashish Vaswani" || got.Metadata.Lookup != "done" {
		t.Fatalf("lookup: %+v", got)
	}
}
func TestLookupDetectsIdentifierOnFirstPage(t *testing.T) {
	s := testServer(t)
	hits := scholarFixture(t, s)
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(2))
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	if _, err := s.lookupDocument(context.Background(), d.ID, false); err != errNoIdentifier || hits.Load() != 0 {
		t.Fatalf("lookup without identifiers: %v hits=%d", err, hits.Load())
	}
	dir := s.analysisDir(d.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"pages":2,"metadata":{"Title":"Microsoft Word - draft.docx"},"blocks":[{"id":"p1-b1","page":1,"label":"text","bounds":{"x":0.1,"y":0.1,"width":0.5,"height":0.1},"text":"arXiv:1706.03762v7 [cs.CL] 2 Aug 2023"}]}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := s.lookupDocument(context.Background(), d.ID, false)
	if err != nil || got.Title != "Attention Is All You Need" || got.Metadata.ArXiv != "1706.03762v7" {
		t.Fatalf("detected lookup: %+v %v", got, err)
	}
}
func TestFileTitleOnlyFillsAPlainTitle(t *testing.T) {
	for title, want := range map[string]string{
		"Microsoft Word - paper.docx": "",
		"untitled document":           "",
		"main":                        "",
		"  Learning   Transferable Visual Models": "Learning Transferable Visual Models",
	} {
		if got := fileTitle(layoutManifest{Metadata: map[string]any{"Title": title}}); got != want {
			t.Errorf("%q: %q", title, got)
		}
	}
}
func TestAutoLookupPreference(t *testing.T) {
	s := testServer(t)
	if !s.autoLookupEnabled() {
		t.Fatal("automatic lookup should default on")
	}
	request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{"papers":{"autoLookup":false}}`))
	if s.autoLookupEnabled() {
		t.Fatal("preference ignored")
	}
}

func TestResolveLargePaperConfirmation(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			s := testServer(t)
			scholarFixture(t, s, 160)
			w := request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"1706.03762"}`))
			if w.Code != 409 || !strings.Contains(w.Body.String(), "large-paper") {
				t.Fatalf("missing confirmation: %d %s", w.Code, w.Body.String())
			}
			w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"1706.03762","allowLarge":true,"library":"`+library+`"}`))
			var d Document
			if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &d) != nil || d.Library != library {
				t.Fatalf("confirmed destination: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestCrossrefEmailPreferences(t *testing.T) {
	s := testServer(t)
	initial := s.scholarClient()
	for _, email := range []string{" reader+papers@example.com ", ""} {
		body, _ := json.Marshal(map[string]any{"crossrefEmail": email, "papers": map[string]bool{"autoLookup": false}})
		w := request(t, s, "PUT", "/api/preferences/library", strings.NewReader(string(body)))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		if got := s.scholarClient().CrossrefEmail; got != strings.TrimSpace(email) {
			t.Fatalf("email = %q", got)
		}
		w = request(t, s, "GET", "/api/preferences/library", nil)
		if !strings.Contains(w.Body.String(), `"autoLookup":false`) {
			t.Fatal("other preferences lost")
		}
	}
	if initial.CrossrefEmail != "" {
		t.Fatal("mutated an in-flight client")
	}
	for _, value := range []string{`"bad"`, `"Name <a@example.com>"`, `123`, `null`, `"a@example.com\r\nBcc:b@example.com"`} {
		w := request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{"crossrefEmail":`+value+`}`))
		if w.Code != 400 {
			t.Fatalf("accepted %s: %d", value, w.Code)
		}
	}
}
